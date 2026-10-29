#!/usr/bin/env node
/**
 * activeKey 迁移（md/55 §5.2）。
 *
 * 新代码给 GenerationTask 加了 `activeKey` 与 sparse 唯一索引，用来在数据库层
 * 保证「同一用户只有一个 queued/running 任务」。上线前必须先清掉历史重复活跃
 * 任务，否则 `syncIndexes()` 建索引会直接失败。
 *
 * 用法：
 *   node scripts/migrate-generation-active-key.mjs            # dry-run，只打印
 *   node scripts/migrate-generation-active-key.mjs --yes      # 真的写入
 *
 * 做的事：
 *   1. 所有 queued/running 任务按 userId 分组，保留 createdAt 最新的一条；
 *   2. 其余重复活跃任务标 failed + TASK_INTERRUPTED，退额度，清 activeKey；
 *   3. 所有终态任务清掉残留的 activeKey；
 *   4. 建唯一索引。
 *
 * 幂等：已经是 `activeKey = userId` 的组会被跳过；重复执行不会重复退款
 * （退款前先用 `quota.refundedAt` 抢一次退还权）。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { ERROR_CODES } from '../src/shared/errors.js'
import { GenerationTask } from '../src/modules/readings/generation-task.model.js'
import { releaseQuota } from '../src/modules/quota/quota.service.js'

const hasFlag = (name) => process.argv.includes(`--${name}`)
const write = hasFlag('yes') && !hasFlag('dry-run')

/** 退还某个任务占用的每日额度；返回是否真的退了一次 */
async function refundTaskQuota(taskId) {
  const task = await GenerationTask.findOneAndUpdate(
    {
      _id: taskId,
      'quota.keys.0': { $exists: true },
      'quota.refundedAt': null,
    },
    { $set: { 'quota.refundedAt': new Date() } },
    { new: false },
  )

  if (!task) return false

  await releaseQuota({ keys: task.quota?.keys ?? [], day: task.quota?.day })
  return true
}

async function main() {
  await mongoose.connect(config.mongodbUri)
  console.log(`connected: ${mongoose.connection.name}`)
  console.log(write ? '模式：写入' : '模式：dry-run（加 --yes 才会写入）')

  const activeTasks = await GenerationTask.find({ status: { $in: ['queued', 'running'] } })
    .select('_id userId status activeKey createdAt quota.keys')
    .sort({ createdAt: 1 })
    .lean()

  const byUser = new Map()
  for (const task of activeTasks) {
    const list = byUser.get(task.userId) ?? []
    list.push(task)
    byUser.set(task.userId, list)
  }

  const keep = []
  const duplicates = []

  for (const [userId, tasks] of byUser) {
    // 按 createdAt 升序读入，最后一条就是最新的
    const keeper = tasks.at(-1)
    keep.push({ userId, task: keeper })
    duplicates.push(...tasks.slice(0, -1).map((task) => ({ userId, task })))
  }

  const needsRefund = duplicates.filter(({ task }) => task.quota?.keys?.length)
  console.log(`活跃任务：${activeTasks.length} 条 / ${byUser.size} 个用户`)
  console.log(`保留：${keep.length} 条`)
  console.log(`重复：${duplicates.length} 条（其中占过额度 ${needsRefund.length} 条）`)

  for (const { userId, task } of duplicates) {
    console.log(`  drop ${task._id} user=${userId} status=${task.status}`)
  }

  if (!write) {
    const terminalWithKey = await GenerationTask.countDocuments({
      status: { $nin: ['queued', 'running'] },
      activeKey: { $exists: true },
    })

    console.log(`终态残留 activeKey：${terminalWithKey} 条待清理`)
    console.log('\n当前是 dry-run，没有写入。确认无误后加 --yes 执行。')
    return
  }

  let refunded = 0

  // 先把重复任务打成终态并清键，再给 keeper 写 activeKey：
  // 反过来的话，唯一索引存在时 keeper 的写入会先撞上重复文档
  for (const { task } of duplicates) {
    const flipped = await GenerationTask.findOneAndUpdate(
      { _id: task._id, status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'failed',
          stage: 'done',
          finishedAt: new Date(),
          owner: null,
          heartbeatAt: null,
          error: {
            code: ERROR_CODES.TASK_INTERRUPTED,
            message: '迁移时发现同一用户有多个活跃任务，这一条已终止，请重试',
            details: null,
          },
        },
        $unset: { activeKey: 1 },
      },
    )

    // 条件更新没命中说明这期间它自己结束了，不能退一笔已经交付的额度
    if (flipped && (await refundTaskQuota(task._id))) refunded += 1
  }

  for (const { userId, task } of keep) {
    // 条件更新：迁移期间它可能刚好跑完，不能给终态文档重新挂上 activeKey
    await GenerationTask.updateOne(
      { _id: task._id, status: { $in: ['queued', 'running'] } },
      { $set: { activeKey: userId } },
    )
  }

  const cleaned = await GenerationTask.updateMany(
    { status: { $nin: ['queued', 'running'] }, activeKey: { $exists: true } },
    { $unset: { activeKey: 1 } },
  )

  console.log(`\n已终止重复任务：${duplicates.length} 条`)
  console.log(`已退额度：${refunded} 条`)
  console.log(`已清理终态 activeKey：${cleaned.modifiedCount} 条`)

  // 最后一步才建索引：前面没清干净的话这里会失败，而不是留下一个「看起来成功」的迁移
  await GenerationTask.syncIndexes()
  console.log('activeKey 唯一索引已同步')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
