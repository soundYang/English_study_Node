import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

/**
 * 队满 503 的准入顺序（md/55 §3.2 I1）。
 *
 * 关键不是「返回了 503」，而是**在扣额度之前**返回：被拒的请求
 * 既没有任务，也没有少一次每日次数。
 *
 * 这里用一个同步生成占住唯一的执行槽，避免和「每用户一个活跃任务」
 * 的 409 混在一起——那是另一条闸门，会在抢执行槽之前先命中。
 */
process.env.GENERATION_MAX_ACTIVE = '1'
process.env.GENERATION_MAX_QUEUE = '0'
process.env.DAILY_QUOTA_ENABLED = 'true'

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson: vi.fn() }))

const { createApp } = await import('../app.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Quota } = await import('../modules/quota/quota.model.js')
const { scheduler } = await import('../modules/readings/generation-task.service.js')

const app = createApp()
const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe('任务层队满', () => {
  it('执行槽已满 → 503 GENERATION_SATURATED，不建任务、不扣额度', async () => {
    const gate = deferred()
    const holding = scheduler.runSync(() => gate.promise)

    const blocked = await request(app).post('/api/readings/generate/tasks').send(BODY)

    expect(blocked.status).toBe(503)
    expect(blocked.body.error.code).toBe('GENERATION_SATURATED')
    expect(blocked.headers['retry-after']).toBe('5')
    expect(blocked.body.error.details).toMatchObject({
      retryAfter: 5,
      maxActive: 1,
      maxQueue: 0,
    })

    expect(await GenerationTask.countDocuments({})).toBe(0)
    expect(await Quota.countDocuments({})).toBe(0)

    gate.resolve()
    await holding
  })
})
