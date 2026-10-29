import { randomUUID } from 'node:crypto'

import mongoose from 'mongoose'

import { config } from '../../config/index.js'
import {
  ERROR_CODES,
  generationTimeout,
  taskInProgress,
  taskNotFound,
} from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { resolveAiKey } from '../ai-keys/ai-key.service.js'
import { assertBudgetAvailable } from '../budget/budget.service.js'
import { releaseQuota, releaseReservation, reserveQuota } from '../quota/quota.service.js'
import { createGenerationScheduler } from './generation-scheduler.js'
import { generationTaskRepository as repo } from './generation-task.repository.js'
import { createTaskSchema } from './reading.schema.js'
import { generateReading } from './reading.service.js'

/**
 * 生成任务的外壳（md/31）。
 *
 * 职责只有三件：建任务、把进度写回任务、把任务翻译成 DTO。
 * **生成逻辑一行都不在这里**——它调的就是 `/readings/generate` 用的
 * 同一个 `generateReading`。两套生成代码并行三个月后一定会分叉，
 * 这是本次改造最重要的一条约束（md/31 §8）。
 */

/**
 * 这些失败改参数才有用，原样重试只会再失败一次。
 * 其余（上游错误、结构非法、残篇、内部异常）都可以直接重新提交。
 */
/**
 * 本进程的实例 id（md/31 §11 多实例）。
 *
 * 只用来回答「这个任务是不是我持有的」，不做持久身份——重启换一个 id 正好：
 * 旧 id 的任务心跳会自然过期，被巡检回收，不需要额外的「实例下线」通知。
 */
export const INSTANCE_ID = randomUUID()

const NON_RETRYABLE = new Set([
  ERROR_CODES.INSUFFICIENT_VOCABULARY,
  ERROR_CODES.VOCABULARY_TOO_SMALL,
  ERROR_CODES.INVALID_REQUEST,
  // md/54：选词不在词库里，重试只会再失败一次；用户要做的是改选词或把词加进词库
  ERROR_CODES.FOCUS_WORDS_NOT_LEARNED,
])

/** 参数比对用：把「集合」语义的 vocabScope 排序，避免 ['all','today_new'] 与反序被当成不同请求 */
function fingerprint(params) {
  return JSON.stringify({
    level: params?.level ?? null,
    targetWords: params?.targetWords ?? null,
    questionCount: params?.questionCount ?? null,
    vocabScope: [...(params?.vocabScope ?? [])].sort(),
    // md/41 / md/42：三态参与比对——true / false / null（未传 = 自动）。
    // 开关不同就是不同请求，不能复用上一个任务；「未传」与「显式 false」
    // 也必须分开，否则最终模式的自动默认会被一次显式关闭污染
    allowNewWords: params?.allowNewWords ?? null,
    // md/54：集合语义，排序后比对；顺序不同不应算成两次不同请求
    focusWords: [...(params?.focusWords ?? [])].sort(),
  })
}

/**
 * 任务的参数回显。`allowNewWords` 用 null 表示「请求没传 = 自动」，
 * 与显式 false 区分开（md/42）。建任务 202 响应与轮询 DTO 共用这一份。
 */
export function toTaskParams(task) {
  return {
    level: task.params?.level ?? null,
    targetWords: task.params?.targetWords ?? null,
    questionCount: task.params?.questionCount ?? null,
    vocabScope: [...(task.params?.vocabScope ?? [])],
    allowNewWords: task.params?.allowNewWords ?? null,
    // md/54：null = 没传（自动）；数组 = 用户的选择。[] 不会出现——schema 已拦
    focusWords: task.params?.focusWords?.length ? [...task.params.focusWords] : null,
  }
}

/**
 * 任务的对外形状。字段与 md/31 §3.2 一一对应，
 * 前端只认这一份，不要另外拼。
 */
export function toTaskDto(task) {
  const failed = task.status === 'failed'
  const error = failed && task.error?.code
    ? {
        code: task.error.code,
        message: task.error.message ?? '',
        details: task.error.details ?? null,
      }
    : null

  return {
    taskId: String(task._id),
    status: task.status,
    stage: task.stage,
    progress: {
      done: task.progress?.done ?? 0,
      total: task.progress?.total ?? 0,
    },
    params: toTaskParams(task),
    selectedWords: (task.selectedWords ?? []).map((item) => ({
      word: item.word,
      kind: item.kind,
      phonetic: { uk: item.phonetic?.uk ?? '', us: item.phonetic?.us ?? '' },
      senses: (item.senses ?? []).map(({ pos, meaning }) => ({ pos, meaning })),
    })),
    segments: (task.segments ?? []).map((item) => ({
      index: item.index,
      status: item.status,
      words: item.words ?? 0,
    })),
    readingId: task.readingId ? String(task.readingId) : null,
    error,
    // 能不能调 POST /generate/tasks/:id/retry：
    // 参数错、词不够这类换参数才有用，重试只会再失败一次
    retryable: error ? !NON_RETRYABLE.has(error.code) : false,
    // 0 = 第一次跑；每重试一次 +1，前端可以显示「第 2 次尝试 · 复用 7 段」
    retryCount: task.retryCount ?? 0,
    durationMs: task.durationMs ?? null,
    createdAt: task.createdAt ?? null,
  }
}

/**
 * 进度写回。用一个闭包维护段状态，避免「每段回读一次任务文档」。
 *
 * 为什么是闭包而不是直接 $set：段级回调会逐个到达（并发 4 段，但回调按批顺序发出），
 * 每次都算一遍完整数组再整体写回，就不需要 Mongo 的数组过滤器与下标定位。
 * 单进程单任务，闭包与库里的值不会分叉；真分叉了也只是进度显示错，不影响文章。
 */
function makeProgressHandler(taskId, { onCancelled = null } = {}) {
  const segments = new Map()
  let total = 0
  let names = []

  const snapshot = () => {
    const list = [...segments.values()].sort((left, right) => left.index - right.index)
    const done = list.filter((item) => item.status === 'accepted' || item.status === 'dropped').length

    return { done, total, list }
  }

  return async (patch) => {
    if (!patch || typeof patch !== 'object') return

    const update = {}

    if (patch.stage) update.stage = patch.stage

    if (Array.isArray(patch.selectedWords)) update.selectedWords = patch.selectedWords

    // 计划定型：续跑的全部依据。写在这里而不是失败之后，是因为
    // 「写了几段之后失败」才是最需要续跑的情况
    if (patch.plan) update.plan = patch.plan

    if (patch.progress && Number.isFinite(patch.progress.total)) {
      total = patch.progress.total
      // 第一次拿到总数就把格子全部建出来：前端要先把 10 个格子画出来，
      // 之后每段落地只是改状态，不是往数组里追加
      if (segments.size === 0) {
        for (let index = 1; index <= total; index += 1) {
          segments.set(index, { index, status: 'pending', words: 0, attempts: 0, text: '' })
        }
      }
    }

    if (patch.segment) {
      const { index, status, words, attempts, text } = patch.segment
      const previous = segments.get(index)

      segments.set(index, {
        index,
        status,
        words: words ?? 0,
        attempts: attempts ?? previous?.attempts ?? 0,
        // 补段失败时不要用空串盖掉上一次收下的正文
        text: text || previous?.text || '',
      })

      if (Array.isArray(patch.segment.names) && patch.segment.names.length > 0) {
        names = patch.segment.names
        update.names = names
      }
    }

    const { done, list } = snapshot()
    update.progress = { done, total }
    if (list.length > 0) update.segments = list

    const updated = await repo.updateIfActive(taskId, update)

    // 写回拿到的就是最新文档，不用额外查一次：
    //   null              —— 任务已经是终态（取消 / 被巡检回收 / 已经跑完）
    //   cancelRequested   —— 取消请求落在了别的实例上，这里靠写回看到它
    // 两种情况都意味着「不该再为它花钱了」
    if (!updated || updated.cancelRequested) onCancelled?.()
  }
}

/**
 * 进程内正在跑的任务 → AbortController。
 *
 * 只服务于取消接口：用户点了取消、或者想换一篇重开时，
 * 不该继续为已经没人要的文章付钱。
 */
const activeControllers = new Map()

/** 任务里存的参数是 Mongoose 子文档，展开它拿不到字段，必须显式取一遍 */
function toPlainParams(task) {
  const allowNewWords = task.params?.allowNewWords

  return {
    level: task.params?.level,
    targetWords: task.params?.targetWords,
    questionCount: task.params?.questionCount,
    vocabScope: [...(task.params?.vocabScope ?? [])],
    // 重试必须沿用同一个口径：true / false 原样带走；**未设置就继续不设置**，
    // 让服务端重新按「自动」判定（最终模式开，其余关）。写成 `=== true`
    // 会把「没传」变成显式 false，最终模式重试后突然变严。
    ...(typeof allowNewWords === 'boolean' ? { allowNewWords } : {}),
    // md/54：只在非空时带上。generateReadingSchema 对 [] 是 400，
    // 重试不能把「没传」变成空数组，否则每次重试都会在参数校验处失败
    ...(task.params?.focusWords?.length
      ? { focusWords: [...task.params.focusWords] }
      : {}),
  }
}

/**
 * 任务里存的计划是 Mongoose 子文档，展开它拿不到字段，必须显式取一遍。
 *
 * 三样缺一不可：提示词、分段表（含 limitWords）、已认出的专有名词。
 * 任何一样缺失都退回 `null`，宁可整篇重跑，也不要拼出一篇语气不一致的文章。
 */
function toResumePlan(task) {
  const plan = task.plan
  if (!plan) return null
  if (typeof plan.systemPrompt !== 'string' || !plan.systemPrompt.trim()) return null
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) return null

  return {
    systemPrompt: plan.systemPrompt ?? '',
    segments: plan.segments.map((segment) => ({
      id: segment.id,
      goal: segment.goal ?? '',
      maxWords: segment.maxWords ?? 0,
      limitWords: segment.limitWords ?? 0,
      mustUse: [...(segment.mustUse ?? [])],
    })),
    names: [...(task.names ?? [])],
    segmentTexts: Object.fromEntries(
      (task.segments ?? [])
        .filter((segment) => segment.status === 'accepted' && segment.text)
        .map((segment) => [String(segment.index), segment.text]),
    ),
  }
}

/**
 * 终态写入自带兜底。
 * 这个函数跑在 setImmediate 里没人 await，任何一处 reject 都会变成
 * 进程级的 unhandledRejection——写库失败只该记日志。
 */
async function finishTask(taskId, data) {
  try {
    await repo.finish(taskId, data)
  } catch (error) {
    logger.error({ err: error, taskId }, 'generation task finish writeback failed')
  }
}

/**
 * 退还一次任务的每日额度（md/35 §6.3）。
 *
 * 三条路径会调用：生成失败、取消且没有任何产出、失联被回收。
 * 并发安全：先用 `quota.refundedAt` 抢退还权，抢不到的返回 null 直接跳过。
 * **必须带状态**：失败与成功的写回可能并发，不判状态会把已交付的文章也退掉。
 */
async function refundTaskQuota(taskId, status) {
  try {
    const task = await repo.claimQuotaRefund(taskId, status)
    if (!task) return false

    await releaseQuota({ keys: task.quota?.keys ?? [], day: task.quota?.day })
    logger.info({ taskId, day: task.quota?.day }, 'generation task quota refunded')
    return true
  } catch (error) {
    // 退款失败最多让用户少一次额度，不能把调用它的失败路径再打断
    logger.warn({ err: error, taskId }, 'generation task quota refund failed')
    return false
  }
}

/**
 * 一次心跳（md/31 §11）。
 *
 * 心跳失败（写库报错）不能把任务判死——下一次心跳还会再来；
 * 只有「查不到」才说明租约没了：被取消、被巡检回收、或者 owner 被清空。
 */
async function heartbeatOnce(taskId, controller) {
  try {
    const task = await repo.heartbeat(taskId, INSTANCE_ID, new Date())

    if (!task) {
      logger.warn({ taskId }, 'generation task lease lost')
      controller.abort()
      return
    }

    // 别的实例上点了取消：库里已经写了 cancelled，这边只负责停手
    if (task.cancelRequested) controller.abort()
  } catch (error) {
    logger.warn({ err: error, taskId }, 'generation task heartbeat failed')
  }
}

/**
 * 真正跑一次生成（md/55 §4.3.0）。
 *
 * 调度器只传 taskId：执行参数必须从任务文档重建，这样任务才能在进程内
 * 排队，P1 换成数据库队列后任何实例都能接手。
 * 异常一律转成任务状态，不往外抛。
 */
async function runTask(taskId) {
  const task = await repo.findById(taskId)

  if (!task || !['queued', 'running'].includes(task.status)) {
    logger.info({ taskId }, 'generation task not runnable, skipped')
    return
  }

  const userId = task.userId
  const body = toPlainParams(task)
  const resume = config.generationStrategy === 'segmented' ? toResumePlan(task) : null
  const startedAt = new Date()

  // 任务没有客户端连接可断：controller 只服务于取消与丢租；
  // timeout 是整篇 deadline，两者用 any 合成一个 signal 传给生成链路。
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(config.generationDeadlineMs)
  const signal = AbortSignal.any([controller.signal, timeout])

  activeControllers.set(String(taskId), controller)

  let heartbeat = null

  try {
    // 抢占而不是无条件改成 running：多实例下同一任务只有一个实例能跑。
    // 排队期间被取消 / 已被别的实例认领时 claim 返回 null，直接退出
    const claimed = await repo.claim(taskId, { owner: INSTANCE_ID, now: startedAt })

    if (!claimed) {
      logger.info({ taskId }, 'generation task not claimable, skipped')
      return
    }

    // 取消接口可能在 claim 之前就 abort 了（controller 已注册）
    if (controller.signal.aborted) {
      logger.info({ taskId }, 'generation task cancelled before start')
      return
    }

    // md/43 §6.3：执行时重新解析一次——任务可能在队列里等了一会儿，
    // 期间 Key 可能被删 / 被替换。创建时按哪种方式付钱，任务上记着
    const aiKey = await resolveAiKey(userId)

    // 创建时选了自备 Key、执行时却解不出来：**不能**悄悄改花免费池。
    // 那既是未经用户同意的扣费，也绕过了每日额度与免费池两道闸。
    if (claimed.aiKeySource === 'user' && aiKey.source !== 'user') {
      const finishedAt = new Date()

      await finishTask(taskId, {
        status: 'failed',
        stage: 'done',
        finishedAt,
        durationMs: finishedAt - startedAt,
        owner: null,
        heartbeatAt: null,
        error: {
          code: ERROR_CODES.USER_API_KEY_MISSING,
          message: '自备 API Key 已不可用，请重新导入后再重试。',
          details: null,
        },
      })
      // 用户什么都没拿到，每日额度原路退回（quota 为空时是 no-op）
      await refundTaskQuota(taskId, 'failed')

      logger.warn({ taskId }, 'generation task failed: user api key missing')
      return
    }

    // 创建时还没 Key、执行时已经有了：尊重用户当前的选择改用自备 Key，
    // 并把创建时占的每日额度退回（md/43 §6.3）
    if (claimed.aiKeySource !== 'user' && aiKey.source === 'user') {
      await refundTaskQuota(taskId)
      await repo.setAiKeySource(taskId, 'user').catch((error) => {
        logger.warn({ err: error, taskId }, 'generation task key source write failed')
      })
    }

    heartbeat = setInterval(() => {
      void heartbeatOnce(taskId, controller)
    }, config.taskHeartbeatMs)
    // 不拖着进程不退出：这个定时器是后台维护，不是业务
    heartbeat.unref?.()

    const onProgress = makeProgressHandler(taskId, { onCancelled: () => controller.abort() })

    const dto = await generateReading({
      userId,
      // token 流水挂到任务上（md/37）：被取消的任务也要有人认账
      taskId,
      body,
      signal,
      onProgress,
      resume,
      aiKey,
    })

    // 打桩客户端可能不理会 signal：即使它跑完了，deadline 已到也不能当成功
    if (timeout.aborted) throw generationTimeout({ deadlineMs: config.generationDeadlineMs })

    const finishedAt = new Date()

    await finishTask(taskId, {
      status: 'succeeded',
      stage: 'done',
      readingId: dto.id,
      finishedAt,
      durationMs: finishedAt - startedAt,
      // 交还租约：任务已经结束，没有实例持有它
      owner: null,
      heartbeatAt: null,
    })

    logger.info({ taskId, readingId: dto.id, durationMs: finishedAt - startedAt }, 'generation task succeeded')
  } catch (error) {
    // 真正的用户取消 / 丢租：状态已经被取消接口或巡检写过，这里保持静默。
    // 注意不能把 deadline 也归到这里——那会让超时任务永远不写终态（md/55 §4.7）
    if (controller.signal.aborted) {
      logger.info({ taskId }, 'generation task aborted')
      return
    }

    const finishedAt = new Date()
    const timeoutError = timeout.aborted
      ? generationTimeout({ deadlineMs: config.generationDeadlineMs })
      : null
    const code = timeoutError?.code ?? error?.code ?? ERROR_CODES.INTERNAL_ERROR

    await finishTask(taskId, {
      status: 'failed',
      stage: 'done',
      finishedAt,
      durationMs: finishedAt - startedAt,
      owner: null,
      heartbeatAt: null,
      error: {
        code,
        message: timeoutError?.message ?? error?.message ?? '生成失败，请重试',
        details: timeoutError?.details ?? error?.details ?? null,
      },
    })

    // 失败终态 = 用户什么都没拿到，额度退回去（md/35 §4.3）
    await refundTaskQuota(taskId, 'failed')

    logger.warn({ taskId, code, durationMs: finishedAt - startedAt }, 'generation task failed')
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    activeControllers.delete(String(taskId))
  }
}

/**
 * POST /api/readings/generate/tasks
 *
 * 三道判断按 md/31 §5 的顺序：clientToken → 同参复用 → 不同参报 409。
 * 参数校验在这里同步做完，非法参数不会留下一个注定失败的任务。
 */
export async function createGenerationTask({ userId, body, identity = null }) {
  const { clientToken, ...generationParams } = parseOrThrow(createTaskSchema, body)

  if (clientToken) {
    const existing = await repo.findByClientToken({ userId, clientToken })
    if (existing) return { task: existing, reused: true }
  }

  const active = await repo.findActive(userId)
  if (active) {
    // 同参数的重复点击（双击、双开页面）直接复用，不扣第二次钱
    if (fingerprint(active.params) === fingerprint(generationParams)) {
      return { task: active, reused: true }
    }

    // 参数不同就不能复用：用户要的是 600 词，给他 200 词的进度是错的
    throw taskInProgress({ taskId: String(active._id) })
  }

  // 先占调度槽：队满在这里 503，此时还没解析 Key、没扣额度（md/55 §3.2 I1）
  const slot = scheduler.reserve()

  let aiKey
  let reservation = null
  let task = null

  try {
    // md/43 §6.3：自备 Key 不过每日额度 / 免费池这两道闸——花的是用户自己的钱
    aiKey = await resolveAiKey(userId)

    if (aiKey.source === 'free') {
      // 免费池到顶就停（md/36）。放在幂等判断之后：已经建好的任务照样能复用 / 轮询，
      // 放在预扣之前：被预算挡下的请求不该扣掉用户当天的额度
      await assertBudgetAvailable()
    }

    // 预扣必须排在三道幂等判断之后（md/35 §4.2）：双击的第二次点击、
    // 同参复用、409 都不扣；放在前面会让一次点击白掉两次额度
    reservation = aiKey.source === 'free'
      ? await reserveQuota({ identity: identity ?? {} })
      : null

    const document = {
      userId,
      clientToken: clientToken ?? null,
      // 活跃任务唯一键；终态由 repo.finish / 巡检统一 $unset
      activeKey: userId,
      // 队列持有者与心跳：巡检据此区分「正常排队」和「实例失联」
      owner: INSTANCE_ID,
      heartbeatAt: new Date(),
      status: 'queued',
      stage: 'queued',
      params: {
        level: generationParams.level,
        targetWords: generationParams.targetWords,
        questionCount: generationParams.questionCount,
        vocabScope: generationParams.vocabScope,
        // 原样存：undefined 表示「没传」= 自动，不能被压成 false
        allowNewWords: generationParams.allowNewWords,
        // md/54：同样保留 undefined；没选词的任务不要写成 []
        focusWords: generationParams.focusWords,
      },
      model: config.deepseekModel,
      strategy: config.generationStrategy,
      // 这次按哪种方式付钱（md/43 §7.3）。执行时据此判断要不要重新解析 Key
      aiKeySource: aiKey.source,
      // 开关关闭时 reservation 是 null，任务文档上不留 quota 字段（与老任务同形）
      ...(reservation && { quota: { keys: reservation.keys, day: reservation.day } }),
    }

    try {
      task = await repo.create(document)
    } catch (error) {
      if (error?.code !== 11000) throw error

      // 两个并发创建都通过了「先查再建」，唯一索引只放一个进来。
      // 另一个要区分「同参复用」和「参数不同 409」（md/55 §4.3.1）
      const current = await repo.findActive(userId)

      if (current && fingerprint(current.params) === fingerprint(generationParams)) {
        slot.release()
        await releaseReservation(reservation)
        reservation = null
        return { task: current, reused: true }
      }

      // 唯一键命中了一条已经终态的脏数据：清掉后重试一次，避免用户被永久锁死
      if (!current) {
        const dirty = await repo.findByActiveKey(userId)
        if (dirty) {
          await repo.clearActiveKey(dirty._id)
          try {
            task = await repo.create(document)
          } catch (retryError) {
            // 重试仍撞唯一键：说明另一个请求刚好抢到了，按 409 处理
            if (retryError?.code === 11000) throw taskInProgress({ taskId: '' })
            throw retryError
          }
        }
      }

      if (!task) {
        throw taskInProgress({ taskId: current ? String(current._id) : '' })
      }
    }
  } catch (error) {
    // 任务没建起来就不算一次使用；不退的话用户会凭空少一次
    slot.release()
    await releaseReservation(reservation)
    throw error
  }

  // 队列只存 taskId：runTask 会从任务文档重建参数（md/55 §4.3.0）
  scheduler.enqueue(task._id, slot)

  return { task, reused: false }
}

/** GET /api/readings/generate/tasks/:id */
export async function getGenerationTask({ userId, id }) {
  // 非法 ObjectId 与不存在走同一个出口：对前端来说都是「这个任务没了」
  if (!mongoose.isValidObjectId(id)) throw taskNotFound()

  const task = await repo.findByIdAndUser(id, userId)
  if (!task) throw taskNotFound()

  return toTaskDto(task)
}

/**
 * POST /api/readings/generate/tasks/:id/cancel
 *
 * 取消是「不再为它付钱」，不是「回滚」：已经收下的段留在任务里，
 * 之后调 retry 还能接着写。终态任务再点取消直接返回当前状态——
 * 网络慢的时候前端连点两次是常态，不该报错。
 */
export async function cancelGenerationTask({ userId, id }) {
  if (!mongoose.isValidObjectId(id)) throw taskNotFound()

  const task = await repo.findByIdAndUser(id, userId)
  if (!task) throw taskNotFound()

  if (task.status !== 'queued' && task.status !== 'running') return toTaskDto(task)

  // 还没开跑的任务直接从队列移除并释放槽位；已开跑的靠 AbortController。
  // 两条路都先于终态写入，避免 runTask 把 cancelled 覆盖成 failed。
  scheduler.cancelQueued(task._id)
  activeControllers.get(String(task._id))?.abort()

  const finishedAt = new Date()
  const updated = await repo.finish(task._id, {
    status: 'cancelled',
    stage: 'done',
    // 取消可能落在别的实例上：持有者靠这个标记（以及 owner 被清空后的丢租）
    // 在下一个心跳 / 下一次进度写回时停手。清掉 owner 同时让心跳立刻查不到
    cancelRequested: true,
    owner: null,
    heartbeatAt: null,
    error: null,
    readingId: null,
    finishedAt,
    durationMs: task.startedAt ? finishedAt - task.startedAt : null,
  })

  // finish 是条件更新：正好在这一刻跑完的任务不会被「取消」成 cancelled，
  // 返回库里真实的终态，前端据 status 决定是跳转还是回到生成页
  const latest = updated ?? (await repo.findByIdAndUser(id, userId)) ?? task

  // 只有「零产出」的取消才退额度（md/35 §4.3）。
  // 已经写完几段再取消也全额退的话，「生成到 80% → 取消 → 重试」
  // 每一轮都能白嫖 4/5 篇的 token，次数永远是 1。
  if (latest.status === 'cancelled' && (latest.progress?.done ?? 0) === 0) {
    await refundTaskQuota(latest._id, 'cancelled')
  }

  return toTaskDto(latest)
}

/**
 * POST /api/readings/generate/tasks/:id/retry（md/31 §11 段级续跑）
 *
 * 与「重新建一个任务」的区别只有一处，但省掉的钱最多：
 * 已收下的段正文留在任务里，续跑时这些段不再调模型（`prewritten`），
 * 计划、提示词、段级预算也都用第一次跑的那份。
 *
 * 所以**必须重开同一个任务**，不能新建：新任务没有旧正文。
 */
export async function retryGenerationTask({ userId, id, identity = null }) {
  if (!mongoose.isValidObjectId(id)) throw taskNotFound()

  const task = await repo.findByIdAndUser(id, userId)
  if (!task) throw taskNotFound()

  // 还在跑 / 已经成功：重试没有意义。连点两次的第二次走到这里，复用而不是报错
  if (task.status === 'queued' || task.status === 'running') return { task, reused: true }
  if (task.status === 'succeeded') return { task, reused: true }

  // 每用户同时只跑一个任务：别的任务还在跑时不能开第二条
  const active = await repo.findActive(userId)
  if (active) throw taskInProgress({ taskId: String(active._id) })

  // 重试同样要抢执行槽：队满 503，且还没动任务/额度（md/55 §4.3.2）
  const slot = scheduler.reserve()

  let reservation = null
  let reopened = null

  try {
    // md/43 §6.3：重试与创建同一套——重新解析 Key、按当前状态决定要不要过闸
    const aiKey = await resolveAiKey(userId)
    const useUserKey = aiKey.source === 'user'

    if (!useUserKey) {
      // 重试会真的再调模型，同样受全局预算约束（md/36）
      await assertBudgetAvailable()
    }

    // 上次的额度还没退、这次改用自备 Key：先退回，免得白占一天（md/43 §6.3）
    if (useUserKey) await refundTaskQuota(task._id)

    // 上次是「失败」或「零产出取消」→ 额度已经退过，这次要重新占一次。
    // 有产出的取消（已收下段落）没有退过，重试沿用原占用，不再扣（md/35 §4.3）。
    // 上次用自备 Key 的任务没占过额度，这次回到免费路径要占一次（md/43 §6.3）。
    // 自备 Key 本身永远不占每日额度
    const needsReservation = !useUserKey
      && (Boolean(task.quota?.refundedAt) || task.aiKeySource === 'user')
    reservation = needsReservation
      ? await reserveQuota({ identity: identity ?? {} })
      : null

    const now = new Date()

    try {
      reopened = await repo.reopen(id, {
        status: 'queued',
        stage: 'queued',
        error: null,
        readingId: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        // 租约随状态一起重置：上一次的取消标记不能带进这次尝试
        cancelRequested: false,
        owner: INSTANCE_ID,
        heartbeatAt: now,
        // 重新占住用户唯一活跃键；终态时已经被 finish / 巡检清掉
        activeKey: userId,
        retryCount: (task.retryCount ?? 0) + 1,
        // TTL 建在 createdAt 上，这里一并重置：否则一个快过期的任务重试到一半
        // 会被 TTL 删掉，轮询直接 404，而模型调用已经花出去了
        createdAt: now,
        // 本次的支付路径，runTask 据此判断要不要重新解析 Key（md/43 §6.3）
        aiKeySource: aiKey.source,
        // 自备 Key：旧的占用已经在上面退掉，清空 quota，免得取消/失败时再退一次
        ...(useUserKey
          ? { quota: { keys: [], day: null, refundedAt: null } }
          : reservation && {
              quota: { keys: reservation.keys, day: reservation.day, refundedAt: null },
            }),
      })
    } catch (error) {
      // 两个重试并发：条件更新通常只有一个成功；唯一索引是第二道保险
      if (error?.code === 11000) {
        const latest = await repo.findActive(userId)
        throw taskInProgress({ taskId: latest ? String(latest._id) : '' })
      }
      throw error
    }

    if (!reopened) {
      // 另一个重试请求刚刚把它改走了：刚占的额度和槽位要还回去
      slot.release()
      await releaseReservation(reservation)
      reservation = null

      // 返回库里现在的状态，不起第二条链路
      const latest = await repo.findByIdAndUser(id, userId)
      return { task: latest ?? task, reused: true }
    }
  } catch (error) {
    slot.release()
    await releaseReservation(reservation)
    throw error
  }

  scheduler.enqueue(reopened._id, slot)

  return { task: reopened, reused: false }
}

/**
 * 回收失联任务（md/31 §11）。
 *
 * 任务执行器在进程内，实例没了就没有任何东西会来推进这些任务。
 * 判据是**心跳过期**而不是「谁在启动」：
 *
 * - 单实例时，效果和原来的「启动时全表标失败」完全一样（旧文档没有心跳，直接被收）
 * - 多实例时，别的实例正在跑的任务心跳是新的，重启不会误杀它们
 *
 * 启动时先跑一次（收掉上一个进程留下的），之后由 startTaskSweeper 周期跑。
 */
export async function reclaimInterruptedTasks() {
  const staleBefore = new Date(Date.now() - config.taskStaleMs)
  const error = {
    code: ERROR_CODES.TASK_INTERRUPTED,
    message: '执行实例已失联，任务中断，请重试',
    details: null,
  }

  const [running, queued] = await Promise.all([
    repo.reclaimStaleRunning({ staleBefore, error }),
    repo.reclaimStaleQueued({ staleBefore, error }),
  ])

  const reclaimedIds = [...(running?.reclaimedIds ?? []), ...(queued?.reclaimedIds ?? [])]
  const reclaimedRunning = running?.reclaimedIds?.length ?? 0
  const reclaimedQueued = queued?.reclaimedIds?.length ?? 0
  const count = reclaimedIds.length

  // 被回收 = 执行实例没了、用户什么都没拿到，和普通失败一样退额度
  await Promise.all(reclaimedIds.map((id) => refundTaskQuota(id, 'failed')))

  if (count > 0) {
    logger.warn({ reclaimedRunning, reclaimedQueued }, 'stale generation tasks reclaimed')
  }

  return count
}

/**
 * 周期巡检（md/31 §11）：实例被 kill -9、容器 OOM 时不会走任何清理逻辑，
 * 它持有的任务只能靠别人在心跳过期后回收。
 *
 * 每个实例都跑同一个巡检：回收是条件更新，谁先扫到谁改，不会重复处理。
 * 返回停止函数，进程退出时调用（测试里不启动，否则会拖着 vitest 不结束）。
 */
export function startTaskSweeper({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    reclaimInterruptedTasks().catch((error) => {
      logger.error({ err: error }, 'generation task sweeper failed')
    })
  }, intervalMs)

  // 不因为一个后台维护定时器拖住进程退出
  timer.unref?.()

  return () => clearInterval(timer)
}

/**
 * 任务调度器单例（md/55 §4.2）。
 *
 * 放在文件底部：runTask 是函数声明，会提升；创建/重试调用的是模块初始化
 * 完成后才存在的 `scheduler`，所以不存在 TDZ 问题。
 */
const scheduler = createGenerationScheduler({
  runTask,
  heartbeat: () => repo.touchQueued(INSTANCE_ID, new Date()),
  logger,
})

/** 服务启动时开启队列心跳；测试不启动，避免后台定时器拖住 vitest */
export function startGenerationScheduler() {
  scheduler.startHeartbeat()
}

/** 进程退出时停心跳；已在跑的任务交给 server.close 后的巡检处理 */
export function stopGenerationScheduler() {
  scheduler.stop()
}

/** health 只读快照：不暴露用户、任务 id 或 Key */
export function getGenerationRuntimeSnapshot() {
  return scheduler.snapshot()
}

export { scheduler }
