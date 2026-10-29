import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

/**
 * 整篇 deadline（md/55 §4.7）。
 *
 * 上游故意不理会 signal 之外的任何东西：这里验证的是「到点必须写终态 / 回 504」，
 * 而不是客户端断开（那条路径应当静默，不写响应）。
 */
process.env.GENERATION_DEADLINE_MS = '50'

const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()
const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

/** 只有 signal abort 时才 reject；模拟一个很慢、但顺从取消的上游 */
function hangUntilAbort() {
  chatJson.mockImplementation(({ signal }) => new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }

    signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  }))
}

function seedWords(count = 400) {
  return Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )
}

async function waitForFinish(taskId, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/readings/generate/tasks/${taskId}`)
    if (['succeeded', 'failed', 'cancelled'].includes(res.body?.status)) return res

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return null
}

describe('整篇 deadline', () => {
  it('同步 /generate 超时 → 504 GENERATION_TIMEOUT', async () => {
    await seedWords()
    hangUntilAbort()

    const res = await request(app).post('/api/readings/generate').send(BODY)

    expect(res.status).toBe(504)
    expect(res.body.error.code).toBe('GENERATION_TIMEOUT')
  })

  it('任务超时 → failed + GENERATION_TIMEOUT，不是静默中断', async () => {
    await seedWords()
    hangUntilAbort()

    const created = await request(app).post('/api/readings/generate/tasks').send(BODY)
    expect(created.status).toBe(202)

    const finished = await waitForFinish(created.body.taskId)

    expect(finished).not.toBeNull()
    expect(finished.body.status).toBe('failed')
    expect(finished.body.error.code).toBe('GENERATION_TIMEOUT')
  })
})
