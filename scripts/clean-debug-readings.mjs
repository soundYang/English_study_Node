#!/usr/bin/env node
/**
 * 清理调试期遗留的 Reading 记录（md/21 W10、md/16 §16）。
 *
 * 默认 **dry-run**：只统计、只列前 5 条，一条都不删。
 * 必须显式加 `--yes` 才会执行 deleteMany——练习记录删了就没有了。
 *
 * 用法：
 *   node scripts/clean-debug-readings.mjs                          # 看当前用户有多少条
 *   node scripts/clean-debug-readings.mjs --before 2026-10-28      # 只数 28 号之前创建的
 *   node scripts/clean-debug-readings.mjs --status generated       # 只看未提交的
 *   node scripts/clean-debug-readings.mjs --before 2026-10-28 --yes
 *
 * 范围：
 *   · `--user` 默认取 config.defaultUserId（local-user），fixture 用户的清理归
 *     `seed-test-fixtures.mjs`，两边的口径不要混；
 *   · 只删 Reading。GenerationFailure 有自己的 30 天 TTL（md/16 §3.1），不在这里动；
 *   · `--before` 按本地时区当天 00:00 计，传 10-28 表示「28 号之前的都算」。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Reading } from '../src/modules/readings/reading.model.js'

const STATUSES = ['generated', 'submitted']

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

/** YYYY-MM-DD → 本地时区当天 00:00 */
function parseBefore(raw) {
  if (!raw) return null

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) throw new Error(`--before 格式应为 YYYY-MM-DD，收到：${raw}`)

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)
}

function buildFilter({ userId, before, status }) {
  const filter = { userId }
  if (before) filter.createdAt = { $lt: before }
  if (status) filter.status = status
  return filter
}

async function main() {
  const userId = argValue('user', config.defaultUserId)
  const before = parseBefore(argValue('before'))
  const status = argValue('status')

  if (status && !STATUSES.includes(status)) {
    throw new Error(`--status 只能是 ${STATUSES.join(' / ')}，收到：${status}`)
  }

  const filter = buildFilter({ userId, before, status })

  await mongoose.connect(config.mongodbUri)
  console.log(`mongo connected: ${mongoose.connection.name}`)

  try {
    const total = await Reading.countDocuments(filter)
    const groups = await Reading.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])

    console.log(`\n用户：${userId}`)
    console.log(`条件：${JSON.stringify(filter)}`)
    console.log(`命中：${total} 条`)
    for (const group of groups) console.log(`  ${group._id}: ${group.count}`)

    if (total === 0) return

    const samples = await Reading.find(filter)
      .sort({ createdAt: 1 })
      .limit(5)
      .select('_id level targetWords status createdAt')
      .lean()

    console.log('\n最早的 5 条：')
    for (const item of samples) {
      console.log(
        `  ${item._id}  ${item.level}/${item.targetWords}  ${item.status}  `
          + `${item.createdAt.toISOString()}`,
      )
    }

    if (!hasFlag('yes')) {
      console.log('\ndry-run：没有删除任何记录。确认无误后加 --yes 重跑。')
      return
    }

    const { deletedCount } = await Reading.deleteMany(filter)
    const remaining = await Reading.countDocuments({ userId })
    console.log(`\n已删除 ${deletedCount} 条；该用户还剩 ${remaining} 条。`)
  } finally {
    await mongoose.disconnect()
  }
}

main().catch((error) => {
  console.error('[clean-debug-readings] 失败：', error.message)
  process.exitCode = 1
})
