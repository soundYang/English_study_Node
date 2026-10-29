import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * token 流水 × 生成任务（md/37 §8 S2）。
 *
 * 单元测试只验证「记进去之后怎么归类」；这里验证**透传链**：
 * `runTask → generateReading → 两条策略 → callModel` 的 userId / taskId
 * 真的落到了流水上。这条链断在任何一段，后台都会安静地少记钱。
 *
 * 重点是取消：任务被取消时没有 reading，`aiMeta` 求和永远看不见这笔钱，
 * 只有事件表能留下。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { TokenUsage } = await import('../modules/usage/token-usage.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

function makePayload() {
  return {
    title: 'A Good Day',
    article: ARTICLE,
    translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
    names: ['Tom'],
    questions: Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      question: `Question number ${index + 1} about the story?`,
      type: 'detail',
      evidence: 'Tom is a good boy.',
      options: ['Tom', 'book', 'house', 'friends'],
      correctAnswer: 0,
      explanation: '根据文章内容可知。',
    })),
  }
}

/** 一次调用 300 token（100 输入 + 200 输出） */
const reply = () => ({
  content: JSON.stringify(makePayload()),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

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

const postTask = () => request(app).post('/api/readings/generate/tasks').send(BODY)

async function waitFor(check, { timeoutMs = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  return null
}

async function waitForFinish(taskId) {
  return waitFor(async () => {
    const res = await request(app).get(`/api/readings/generate/tasks/${taskId}`)
    return ['succeeded', 'failed', 'cancelled'].includes(res.body?.status) ? res : null
  })
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('token 流水透传', () => {
  it('任务触发的每次调用都带 taskId 与用户归属', async () => {
    await seedWords()
    chatJson.mockReturnValue(reply())

    const created = await postTask()
    expect(created.status).toBe(202)

    await waitForFinish(created.body.taskId)

    const rows = await waitFor(async () => {
      const found = await TokenUsage.find({ userId: config.defaultUserId }).lean()
      return found.length > 0 ? found : null
    })

    expect(rows).not.toBeNull()
    for (const row of rows) {
      expect(String(row.taskId)).toBe(created.body.taskId)
      expect(row.totalTokens).toBe(300)
      expect(row.promptTokens).toBe(100)
      expect(row.completionTokens).toBe(200)
      expect(row.kind).toBeTruthy()
      expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('跑到一半被取消：流水照样留下（这是 aiMeta 求和看不见的那部分）', async () => {
    await seedWords()

    let release
    const pending = new Promise((resolve) => {
      release = () => resolve(reply())
    })
    chatJson.mockReturnValueOnce(pending)

    const created = await postTask()
    expect(created.status).toBe(202)

    // 等第一次模型调用真的发出，再取消——否则取消的可能是一个还没开跑的任务
    await waitFor(() => chatJson.mock.calls.length > 0)

    const cancelled = await request(app).post(
      `/api/readings/generate/tasks/${created.body.taskId}/cancel`,
    )
    expect(cancelled.status).toBe(200)

    // 被打桩的调用不响应 abort，手动放行：此时任务已是 cancelled，
    // callModel 收到响应后仍会写一条流水
    release()

    const finished = await waitForFinish(created.body.taskId)
    expect(finished.body.status).toBe('cancelled')

    const rows = await waitFor(async () => {
      const found = await TokenUsage.find({
        userId: config.defaultUserId,
        taskId: created.body.taskId,
      }).lean()

      return found.length > 0 ? found : null
    })

    expect(rows).not.toBeNull()
    expect(rows[0].totalTokens).toBe(300)
  })
})
