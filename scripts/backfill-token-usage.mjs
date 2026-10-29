#!/usr/bin/env node
/**
 * 历史 token 回填（md/37 §3.5 / §8 S2）。
 *
 * tokenusages 上线前的花费只存在于两处：
 *   · `readings.aiMeta.totalTokens`      —— 成功文章
 *   · `generationfailures.totalTokens`   —— 失败尝试
 * 把这些各写成一条 `kind: 'legacy'` 的流水，之后后台**只认流水表**。
 *
 * ⚠️ 这是「不丢历史」，不是「新旧相加」。流水表上线后，
 *    聚合就不要再把 readings / failures 求和——那会让每篇文章精确翻倍。
 *
 * 用法：
 *   node scripts/backfill-token-usage.mjs          # dry-run，只统计、不写库
 *   node scripts/backfill-token-usage.mjs --yes    # 真的写入
 *
 * 幂等：按 `(userId, totalTokens, createdAt)` 判重，重复执行不会插两条。
 * 判重只看已有 legacy 记录——新流水（有 taskId / 非 legacy）不参与比对，
 * 否则一条历史文章与一笔同额的实时调用会被误判成重复。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { quotaDay } from '../src/modules/quota/quota.service.js'
import { TokenUsage } from '../src/modules/usage/token-usage.model.js'

const hasFlag = (name) => process.argv.includes(`--${name}`)

const write = hasFlag('yes')

/** 判重键：同一用户、同一 token 数、同一创建时间 = 同一条历史 */
function signatureOf({ userId, totalTokens, createdAt }) {
  return `${userId}|${totalTokens}|${new Date(createdAt).getTime()}`
}

function toEvent({ userId, totalTokens, createdAt, source }) {
  return {
    userId,
    taskId: null,
    kind: 'legacy',
    model: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens,
    day: quotaDay(new Date(createdAt)),
    createdAt: new Date(createdAt),
    // 只进日志提示，不写入模型（schema 未声明，Mongoose 会丢弃）
    source,
  }
}

async function main() {
  await mongoose.connect(config.mongodbUri)
  console.log(`connected: ${mongoose.connection.name}`)

  const [readings, failures, existing] = await Promise.all([
    Reading.find({ 'aiMeta.totalTokens': { $gt: 0 } })
      .select('userId aiMeta.totalTokens createdAt')
      .lean(),
    GenerationFailure.find({ totalTokens: { $gt: 0 } })
      .select('userId totalTokens createdAt')
      .lean(),
    TokenUsage.find({ kind: 'legacy' })
      .select('userId totalTokens createdAt')
      .lean(),
  ])

  const seen = new Set(existing.map(signatureOf))
  const candidates = []

  for (const row of readings) {
    const event = toEvent({
      userId: row.userId,
      totalTokens: row.aiMeta.totalTokens,
      createdAt: row.createdAt,
      source: 'reading',
    })

    const key = signatureOf(event)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(event)
  }

  for (const row of failures) {
    const event = toEvent({
      userId: row.userId,
      totalTokens: row.totalTokens,
      createdAt: row.createdAt,
      source: 'failure',
    })

    const key = signatureOf(event)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(event)
  }

  const sum = candidates.reduce((total, event) => total + event.totalTokens, 0)
  const users = new Set(candidates.map((event) => event.userId))

  console.log(`已有 legacy 流水：${existing.length} 条`)
  console.log(`待回填：${candidates.length} 条 / ${users.size} 个用户 / ${sum} tokens`)
  console.log(`  来自成功文章：${readings.length} 条`)
  console.log(`  来自失败尝试：${failures.length} 条`)

  if (candidates.length > 0) {
    console.log('样例：')
    for (const event of candidates.slice(0, 5)) {
      console.log(`  ${event.userId} ${event.day} ${event.totalTokens} (${event.source})`)
    }
  }

  if (!write) {
    console.log('\n当前是 dry-run，没有写入。确认无误后加 --yes 执行。')
    return
  }

  if (candidates.length === 0) {
    console.log('\n没有需要写入的数据。')
    return
  }

  // 去掉 source，避免把「来源」混进账本字段；模型本身也会丢弃未声明字段
  const docs = candidates.map(({ source, ...rest }) => rest)
  const result = await TokenUsage.insertMany(docs, { ordered: false })

  console.log(`\n已写入 ${result.length} 条 legacy 流水。`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
