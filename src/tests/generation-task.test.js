import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 生成任务（md/31）。
 *
 * 这里只验证「任务外壳」：建任务、幂等、并发闸门、失败归因、DTO 形状。
 * 生成本身的行为由 readings.test.js 覆盖——两条路调的是同一个 generateReading，
 * 在任务里再测一遍文章质量等于把同一批断言写两遍。
 *
 * 上游一律打桩；异步执行靠轮询到终态，不 sleep 固定毫秒。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 与 readings.test.js 同一篇：只含基础词表里的词，落库断言不依赖模型输出质量 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

function makePayload({ questionCount = 3 } = {}) {
  return {
    title: 'A Good Day',
    article: ARTICLE,
    translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
    names: ['Tom'],
    questions: Array.from({ length: questionCount }, (_, index) => ({
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

const reply = (payload) => ({
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

/** easy 100 词的已知词门槛是 647（618 基础词 + 29），400 个词足够越过 */
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

const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

const postTask = (body) => request(app).post('/api/readings/generate/tasks').send(body)
const getTask = (taskId) => request(app).get(`/api/readings/generate/tasks/${taskId}`)

/**
 * 轮询到终态。间隔 25 ms、上限 8 s：
 * 打桩的生成是毫秒级的，超时说明真卡住了，让用例失败比无限等好。
 */
async function waitForFinish(taskId, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    last = await getTask(taskId)
    if (last.body?.status === 'succeeded' || last.body?.status === 'failed') return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return last
}

/** 一个外部能控制的挂起下游：用来制造「任务还在跑」的窗口 */
function deferredChat() {
  const pending = []

  chatJson.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  )

  return {
    /** 放行所有挂起的调用 */
    release(payload = makePayload()) {
      for (const item of pending.splice(0)) item.resolve(reply(payload))
    },
    get size() {
      return pending.length
    },
  }
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('POST /api/readings/generate/tasks · 建任务', () => {
  it('立刻返回 202 与 taskId，不在响应里带正文', async () => {
    await seedWords()
    const gate = deferredChat()

    const res = await postTask(BODY)

    expect(res.status).toBe(202)
    expect(res.body.taskId).toBeTruthy()
    expect(res.body.reused).toBe(false)
    expect(res.body.status).toBe('queued')
    expect(res.body.article).toBeUndefined()

    gate.release()
    await waitForFinish(res.body.taskId)
  })

  it('参数非法 → 400，且不留下任务', async () => {
    const res = await postTask({ ...BODY, level: 'insane' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(await GenerationTask.countDocuments({})).toBe(0)
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('参数原样回显，前端据此显示「这篇是 100 词」', async () => {
    await seedWords()
    const gate = deferredChat()

    const res = await postTask(BODY)

    expect(res.body.params).toMatchObject({ level: 'easy', targetWords: 100, questionCount: 3 })
    expect(res.body.params.vocabScope).toEqual(['all'])

    gate.release()
    await waitForFinish(res.body.taskId)
  })
})

describe('GET /api/readings/generate/tasks/:id · 进度', () => {
  it('跑完后 succeeded，readingId 对应的文章可读', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const { body } = await postTask(BODY)
    const done = await waitForFinish(body.taskId)

    expect(done.status).toBe(200)
    expect(done.body.status).toBe('succeeded')
    expect(done.body.stage).toBe('done')
    expect(done.body.error).toBeNull()
    expect(done.body.durationMs).toBeGreaterThanOrEqual(0)

    const article = await request(app).get(`/api/readings/${done.body.readingId}`)
    expect(article.status).toBe(200)
    expect(article.body.title).toBe('A Good Day')
    expect(await Reading.countDocuments({})).toBe(1)
  })

  it('把本次抽到的目标词一并给前端（含 kind 与释义字段）', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const { body } = await postTask(BODY)
    const done = await waitForFinish(body.taskId)

    // easy 100 词 → 10 个目标词（每 10 个正文词 1 个）
    expect(done.body.selectedWords).toHaveLength(10)
    expect(done.body.selectedWords.filter((item) => item.kind === 'focus').length).toBeGreaterThan(0)
    expect(done.body.selectedWords.filter((item) => item.kind === 'target').length).toBeGreaterThan(0)

    for (const item of done.body.selectedWords) {
      expect(typeof item.word).toBe('string')
      expect(item.phonetic).toHaveProperty('uk')
      expect(Array.isArray(item.senses)).toBe(true)
    }
  })

  it('任务不存在 / id 非法都报 404 TASK_NOT_FOUND', async () => {
    const missing = await getTask('507f1f77bcf86cd799439011')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('TASK_NOT_FOUND')

    const malformed = await getTask('not-an-object-id')
    expect(malformed.status).toBe(404)
    expect(malformed.body.error.code).toBe('TASK_NOT_FOUND')
  })
})

describe('幂等与并发闸门', () => {
  it('同一个 clientToken 只跑一次，第二次复用同一任务', async () => {
    await seedWords()
    const gate = deferredChat()
    const body = { ...BODY, clientToken: 'token-abcdefgh' }

    const first = await postTask(body)
    const second = await postTask(body)

    expect(first.body.reused).toBe(false)
    expect(second.body.reused).toBe(true)
    expect(second.body.taskId).toBe(first.body.taskId)
    expect(await GenerationTask.countDocuments({})).toBe(1)

    gate.release()
    await waitForFinish(first.body.taskId)
  })

  it('没有 token 时，同参数的重复点击复用同一任务', async () => {
    await seedWords()
    const gate = deferredChat()

    const first = await postTask(BODY)
    const second = await postTask(BODY)

    expect(second.body.reused).toBe(true)
    expect(second.body.taskId).toBe(first.body.taskId)

    gate.release()
    await waitForFinish(first.body.taskId)
  })

  it('参数不同且已有任务在跑 → 409 TASK_IN_PROGRESS，并给出正在跑的任务 id', async () => {
    await seedWords()
    const gate = deferredChat()

    const first = await postTask(BODY)
    const second = await postTask({ ...BODY, targetWords: 200 })

    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('TASK_IN_PROGRESS')
    expect(second.body.error.details.taskId).toBe(first.body.taskId)

    gate.release()
    await waitForFinish(first.body.taskId)
  })
})

describe('失败归因', () => {
  it('上游异常 → failed + 原错误码，且不产生文章', async () => {
    await seedWords()
    chatJson.mockRejectedValue(Object.assign(new Error('upstream down'), { code: 'AI_PROVIDER_ERROR' }))

    const { body } = await postTask(BODY)
    const done = await waitForFinish(body.taskId)

    expect(done.body.status).toBe('failed')
    expect(done.body.error.code).toBe('AI_PROVIDER_ERROR')
    // 上游类错误重试有意义
    expect(done.body.retryable).toBe(true)
    expect(await Reading.countDocuments({})).toBe(0)
  })

  it('词量不足 → failed + VOCABULARY_TOO_SMALL，且标记为不可重试', async () => {
    // 不填词：词数 0 < VOCABULARY_THRESHOLD
    const { body } = await postTask(BODY)
    const done = await waitForFinish(body.taskId)

    expect(done.body.status).toBe('failed')
    expect(done.body.error.code).toBe('INSUFFICIENT_VOCABULARY')
    // 原样重试只会再失败一次，得先去加词
    expect(done.body.retryable).toBe(false)
  })
})
