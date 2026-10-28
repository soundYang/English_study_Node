import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 全局免费池 × 生成入口（md/36）。
 *
 * 覆盖四件事：
 *   1. 每次真实模型调用都计数（不是每篇文章）；
 *   2. 到顶后三个入口都被挡住，且不再烧钱；
 *   3. 被挡下的请求不扣每日额度（这里是关闭状态，靠顺序保证）；
 *   4. 失败 / 复用路径的计数口径。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

process.env.TOKEN_BUDGET_ENABLED = 'true'
process.env.FREE_TOKEN_BUDGET = '500'

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { FREE_BUDGET_ID, TokenBudget } = await import('../modules/budget/budget.model.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
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

async function usedTokens() {
  return (await TokenBudget.findById(FREE_BUDGET_ID).lean())?.usedTokens ?? 0
}

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
  const deadline = Date.now() + 8000
  let last = null

  while (Date.now() < deadline) {
    last = await request(app).get(`/api/readings/generate/tasks/${taskId}`)
    if (['succeeded', 'failed', 'cancelled'].includes(last.body?.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return last
}

const postTask = (body = BODY) => request(app).post('/api/readings/generate/tasks').send(body)

beforeEach(() => {
  chatJson.mockReset()
})

describe('计数口径', () => {
  it('每次模型调用都累加；复用活动任务不会再调模型也不会加数', async () => {
    await seedWords()

    // 卡住第一次调用，让任务停在 running，才能走到「复用活动任务」分支
    let release
    const pending = new Promise((resolve) => {
      release = () => resolve(reply())
    })
    chatJson.mockReturnValueOnce(pending)

    const first = await postTask()
    expect(first.status).toBe(202)

    const callsBefore = chatJson.mock.calls.length
    const again = await postTask()
    expect(again.body.reused).toBe(true)
    expect(again.body.taskId).toBe(first.body.taskId)
    expect(chatJson.mock.calls.length).toBe(callsBefore)

    release()
    expect((await waitForFinish(first.body.taskId)).body.status).toBe('succeeded')
    expect(await waitFor(() => usedTokens().then((used) => used === 300))).toBe(true)
  })

  it('失败的生成也计数（花掉的钱不会因为失败而消失）', async () => {
    await seedWords()
    // 模型调用成功、返回结构非法 → 生成失败，但 token 已经花掉。
    // 修正轮会再调几次，所以断言的是「有按调用次数累加的记录」，不是某个固定值
    chatJson.mockResolvedValue({
      content: 'not a json at all',
      usage: { prompt_tokens: 100, completion_tokens: 200 },
    })

    const res = await postTask()
    const done = await waitForFinish(res.body.taskId)

    expect(done.body.status).toBe('failed')
    expect(
      await waitFor(() => usedTokens().then((used) => used >= 300 && used % 300 === 0)),
    ).toBe(true)
  })
})

describe('到顶后停止供给', () => {
  it('超过上限后建任务 → 503 FREE_BUDGET_EXHAUSTED，且不再调用模型', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply())

    // 两次成功 = 600 > 500
    for (let round = 1; round <= 2; round += 1) {
      const res = await postTask()
      expect(res.status).toBe(202)
      expect((await waitForFinish(res.body.taskId)).body.status).toBe('succeeded')
      await waitFor(() => usedTokens().then((used) => used >= round * 300))
    }

    const callsBefore = chatJson.mock.calls.length
    const blocked = await postTask()

    expect(blocked.status).toBe(503)
    expect(blocked.body.error.code).toBe('FREE_BUDGET_EXHAUSTED')
    expect(blocked.body.error.message).toContain('API Key')
    expect(blocked.body.error.details).toEqual({ limitTokens: 500, usedTokens: 600 })
    expect(chatJson.mock.calls.length).toBe(callsBefore)
  })

  it('同步 /generate 同样被挡，且不扣任何额度', async () => {
    await seedWords()
    await TokenBudget.create({ _id: FREE_BUDGET_ID, usedTokens: 500 })

    const res = await request(app).post('/api/readings/generate').send(BODY)

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('FREE_BUDGET_EXHAUSTED')
    expect(chatJson).not.toHaveBeenCalled()
    // 预算挡在预扣之前，不该留下额度记录（这里每日额度是关的，只确认没有异常副作用）
    expect(await GenerationTask.countDocuments({})).toBe(0)
  })

  it('重试也会被挡（重试同样要调模型）', async () => {
    await seedWords()
    await TokenBudget.create({ _id: FREE_BUDGET_ID, usedTokens: 500 })

    const task = await GenerationTask.create({
      userId: config.defaultUserId,
      status: 'failed',
      stage: 'done',
      params: { level: 'easy', targetWords: 100, questionCount: 3, vocabScope: ['all'] },
      error: { code: 'AI_PROVIDER_ERROR', message: 'upstream down' },
    })

    const res = await request(app).post(`/api/readings/generate/tasks/${task._id}/retry`)

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('FREE_BUDGET_EXHAUSTED')
    expect(chatJson).not.toHaveBeenCalled()
  })
})

describe('GET /api/quota · freeBudget', () => {
  it('公开返回预算状态，前端可在生成前就禁用按钮', async () => {
    await TokenBudget.create({ _id: FREE_BUDGET_ID, usedTokens: 120 })

    const res = await request(app).get('/api/quota')

    expect(res.status).toBe(200)
    expect(res.body.freeBudget).toEqual({
      enabled: true,
      limitTokens: 500,
      usedTokens: 120,
      remainingTokens: 380,
      exhausted: false,
    })
  })
})
