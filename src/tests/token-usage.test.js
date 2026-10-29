import { describe, expect, it } from 'vitest'

import { GenerationTask } from '../modules/readings/generation-task.model.js'
import {
  dailyTokensForUser,
  emptyTokenBuckets,
  recordUsageEvent,
  tokenBreakdownByUsers,
  tokenBreakdownForUser,
  usageDay,
} from '../modules/usage/token-usage.service.js'
import { TokenUsage } from '../modules/usage/token-usage.model.js'

/**
 * token 流水（md/37 §3.5 / §4.3）。
 *
 * 这里测的是「钱记到谁头上、按什么归类」，不测 callModel 本身——
 * 透传链由 admin-users.test.js 的端到端用例兜住。
 */

const DAY_MS = 24 * 60 * 60 * 1000

async function makeTask(userId, status) {
  return GenerationTask.create({ userId, status })
}

describe('usageDay', () => {
  it('按北京时间切日：UTC 17 点已经是次日', () => {
    // 2026-10-29T17:00Z = 北京时间 2026-10-30 01:00
    expect(usageDay(new Date('2026-10-29T17:00:00.000Z'))).toBe('2026-10-30')
    // 2026-10-29T15:59Z = 北京时间 23:59
    expect(usageDay(new Date('2026-10-29T15:59:00.000Z'))).toBe('2026-10-29')
  })
})

describe('recordUsageEvent', () => {
  it('写入一条流水，日期按北京时间取', async () => {
    await recordUsageEvent({
      userId: 'u_a',
      taskId: null,
      kind: 'segment',
      model: 'deepseek-chat',
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      now: new Date('2026-10-29T17:00:00.000Z'),
    })

    const rows = await TokenUsage.find({ userId: 'u_a' }).lean()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      totalTokens: 300,
      promptTokens: 100,
      completionTokens: 200,
      day: '2026-10-30',
      kind: 'segment',
    })
  })

  it('keySource 缺省为 free，显式传 user 会落库（md/43 §7.1）', async () => {
    await recordUsageEvent({ userId: 'u_a', totalTokens: 10 })
    await recordUsageEvent({ userId: 'u_a', totalTokens: 20, keySource: 'user' })

    const rows = await TokenUsage.find({ userId: 'u_a' }).sort({ totalTokens: 1 }).lean()

    expect(rows.map((row) => row.keySource)).toEqual(['free', 'user'])
  })

  it('没有归属或 token 不为正数时不写（宁可少一条，也不要记到别人头上）', async () => {
    await recordUsageEvent({ userId: '', totalTokens: 100 })
    await recordUsageEvent({ userId: 'u_a', totalTokens: 0 })
    await recordUsageEvent({ userId: 'u_a', totalTokens: -5 })

    expect(await TokenUsage.countDocuments({})).toBe(0)
  })
})

describe('tokenBreakdownForUser', () => {
  it('按任务终态归类：成功 / 失败 / 取消 / 运行中 / 同步 / 历史', async () => {
    const ok = await makeTask('u_a', 'succeeded')
    const failed = await makeTask('u_a', 'failed')
    const cancelled = await makeTask('u_a', 'cancelled')
    const running = await makeTask('u_a', 'running')

    await recordUsageEvent({ userId: 'u_a', taskId: ok._id, totalTokens: 100 })
    await recordUsageEvent({ userId: 'u_a', taskId: failed._id, totalTokens: 20 })
    // 取消的任务没有 reading，但钱已经花了——这正是事件表存在的理由
    await recordUsageEvent({ userId: 'u_a', taskId: cancelled._id, totalTokens: 30 })
    await recordUsageEvent({ userId: 'u_a', taskId: running._id, totalTokens: 40 })
    // 同步 /generate 没有任务
    await recordUsageEvent({ userId: 'u_a', taskId: null, totalTokens: 5 })
    // 上线前回填
    await recordUsageEvent({ userId: 'u_a', kind: 'legacy', totalTokens: 7 })

    const buckets = await tokenBreakdownForUser('u_a')

    expect(buckets).toEqual({
      total: 202,
      success: 100,
      failed: 20,
      cancelled: 30,
      running: 40,
      sync: 5,
      legacy: 7,
    })
  })

  it('没有流水时返回全零桶，而不是 undefined', async () => {
    expect(await tokenBreakdownForUser('u_nobody')).toEqual(emptyTokenBuckets())
  })
})

describe('tokenBreakdownByUsers', () => {
  it('一页用户一次查完，各自归类', async () => {
    const ok = await makeTask('u_a', 'succeeded')
    const failed = await makeTask('u_b', 'failed')

    await recordUsageEvent({ userId: 'u_a', taskId: ok._id, totalTokens: 10 })
    await recordUsageEvent({ userId: 'u_b', taskId: failed._id, totalTokens: 20 })

    const result = await tokenBreakdownByUsers(['u_a', 'u_b', 'u_c'])

    expect(result.get('u_a')).toMatchObject({ total: 10, success: 10 })
    expect(result.get('u_b')).toMatchObject({ total: 20, failed: 20 })
    // 没有流水的用户不进 Map，调用方用空桶兜底
    expect(result.has('u_c')).toBe(false)
  })

  it('includeUserKey=false 时排除自备 Key 的流水，老文档按 free 计入（md/43 §7.2）', async () => {
    await recordUsageEvent({ userId: 'u_a', totalTokens: 10 })
    await recordUsageEvent({ userId: 'u_a', totalTokens: 20, keySource: 'user' })
    // md/43 之前写入的文档没有这个字段
    await TokenUsage.collection.insertOne({ userId: 'u_a', totalTokens: 5, day: '2026-10-29' })

    const withUser = await tokenBreakdownByUsers(['u_a'])
    const platformOnly = await tokenBreakdownByUsers(['u_a'], null, { includeUserKey: false })

    expect(withUser.get('u_a').total).toBe(35)
    expect(platformOnly.get('u_a').total).toBe(15)
  })

  it('空输入不发查询', async () => {
    expect((await tokenBreakdownByUsers([])).size).toBe(0)
    expect((await tokenBreakdownByUsers(undefined)).size).toBe(0)
  })
})

describe('dailyTokensForUser', () => {
  it('按天聚合、最新在前', async () => {
    const day1 = new Date('2026-10-27T03:00:00.000Z')
    const day2 = new Date(day1.getTime() + 2 * DAY_MS)

    await recordUsageEvent({ userId: 'u_a', totalTokens: 10, now: day1 })
    await recordUsageEvent({ userId: 'u_a', totalTokens: 5, now: day1 })
    await recordUsageEvent({ userId: 'u_a', totalTokens: 7, now: day2 })

    const rows = await dailyTokensForUser('u_a', 30)

    expect(rows).toEqual([
      { _id: '2026-10-29', totalTokens: 7 },
      { _id: '2026-10-27', totalTokens: 15 },
    ])
  })
})
