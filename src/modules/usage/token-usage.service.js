import { logger } from '../../shared/logger.js'
import { quotaDay } from '../quota/quota.service.js'
import { GenerationTask } from '../readings/generation-task.model.js'
import { TokenUsage } from './token-usage.model.js'

/**
 * token 流水的写入与聚合（md/37 §3.5 / §4.3）。
 *
 * 写入点是 `callModel()`，与 md/36 的 `recordTokenUsage()` 并排：
 * 一个记「全站还剩多少」，一个记「这一条该记到谁头上」。
 * **两者都必须吞掉写库异常**——一次已经付过钱的模型调用，
 * 不能因为记账失败被再判一次失败。
 */

/** 北京时间自然日；与每日额度同一个口径，跨日不会出现两种答案 */
export function usageDay(now = new Date()) {
  return quotaDay(now)
}

/**
 * 写一条流水。**不 await、不抛错**：调用方一律用 `void`。
 *
 * @param {{
 *   userId: string,
 *   taskId?: string|object|null,
 *   kind?: string,
 *   model?: string,
 *   promptTokens?: number,
 *   completionTokens?: number,
 *   totalTokens: number,
 *   now?: Date,
 * }} payload
 */
export async function recordUsageEvent({
  userId,
  taskId = null,
  kind = 'generate',
  model = '',
  promptTokens = 0,
  completionTokens = 0,
  totalTokens,
  now = new Date(),
}) {
  // 没有归属就不记：宁可少一条流水，也不要把账记到别人头上
  if (!userId) return
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return

  try {
    await TokenUsage.create({
      userId,
      taskId: taskId ?? null,
      kind,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      day: usageDay(now),
    })
  } catch (error) {
    logger.warn({ err: error, userId, totalTokens }, 'token usage event write failed')
  }
}

export function emptyTokenBuckets() {
  return {
    total: 0,
    success: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    sync: 0,
    legacy: 0,
  }
}

/**
 * 一页用户的 token 明细：`Map<dataKey, buckets>`。
 *
 * 先把流水按 `(userId, taskId, kind)` 收成几十行，再一次性查任务状态。
 * 不能把原始流水全捞进内存——一篇文章 40 条左右，20 个用户就是一屏几万条。
 *
 * @param {string[]} userIds dataKey 列表
 * @param {Array<{_id: any, status: string}>} [taskRows] 调用方已知的任务状态；
 *   不传则按流水里出现的 taskId 自行查询
 */
export async function tokenBreakdownByUsers(userIds, taskRows = null) {
  const result = new Map()
  if (!Array.isArray(userIds) || userIds.length === 0) return result

  const rows = await TokenUsage.aggregate([
    { $match: { userId: { $in: userIds } } },
    {
      $group: {
        _id: { userId: '$userId', taskId: '$taskId', kind: '$kind' },
        totalTokens: { $sum: '$totalTokens' },
      },
    },
  ])

  if (rows.length === 0) return result

  let taskList = taskRows
  if (!taskList) {
    const taskIds = [...new Set(rows.map((row) => row._id.taskId).filter(Boolean))]
    taskList = taskIds.length
      ? await GenerationTask.find({ _id: { $in: taskIds } }).select('_id status').lean()
      : []
  }

  const statusByTask = new Map(taskList.map((task) => [String(task._id), task.status]))

  /** taskId → 这次调用最后换来了什么（§3.5） */
  function bucketOf(taskId) {
    if (!taskId) return 'sync'

    const status = statusByTask.get(String(taskId))

    if (status === 'succeeded') return 'success'
    if (status === 'failed') return 'failed'
    if (status === 'cancelled') return 'cancelled'

    // 查不到任务（被 TTL 清掉）或还在排队/running：都归 running，不猜
    return 'running'
  }

  for (const row of rows) {
    const { userId, taskId, kind } = row._id
    if (!result.has(userId)) result.set(userId, emptyTokenBuckets())

    const buckets = result.get(userId)
    const total = row.totalTokens ?? 0
    buckets.total += total

    // 回填的历史数据没有 taskId，优先按 kind 判，否则会被算成同步调用
    if (kind === 'legacy') buckets.legacy += total
    else buckets[bucketOf(taskId)] += total
  }

  return result
}

/**
 * 单个用户的 token 明细，按「这笔钱最后换来了什么」归类。
 *
 * @param {string} userId dataKey
 * @param {Array<{_id: any, status: string}>} [taskRows] 调用方先查好的任务状态
 */
export async function tokenBreakdownForUser(userId, taskRows = null) {
  const map = await tokenBreakdownByUsers([userId], taskRows)

  return map.get(userId) ?? emptyTokenBuckets()
}

/** 按天聚合（详情页如果要画趋势，直接用这个） */
export async function dailyTokensForUser(userId, days = 30) {
  return TokenUsage.aggregate([
    { $match: { userId } },
    { $group: { _id: '$day', totalTokens: { $sum: '$totalTokens' } } },
    { $sort: { _id: -1 } },
    { $limit: days },
  ])
}
