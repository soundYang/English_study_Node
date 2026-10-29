import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 生词容忍开关 `allowNewWords`（md/41）。
 *
 * 口径：
 *   - easy 固定 0 生词，接口收到 true 直接 400；
 *   - medium / hard 默认关，打开后最多放行 3 / 5 个表外词；
 *   - 打开只是「允许」不是「保证」，模型全用熟词同样合法。
 *
 * 这个文件跑的是 setup.js 里的整篇路径；分段路径的分配逻辑见
 * `allow-new-words-segmented.test.js`。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { GenerationFailure } = await import('../modules/readings/generation-failure.model.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 只用基础词表里的词，落库断言不依赖模型输出质量 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

function makePayload({ article = ARTICLE, questionCount = 3 } = {}) {
  return {
    title: 'A Good Day',
    article,
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

/** medium / hard 100 词的已知词门槛都在 638 上下，1300 个词足够越过 */
function seedWords(count = 1300) {
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

const MEDIUM = { level: 'medium', targetWords: 100, questionCount: 3 }
const HARD = { level: 'hard', targetWords: 100, questionCount: 3 }

const generate = (body) => request(app).post('/api/readings/generate').send(body)
const postTask = (body) => request(app).post('/api/readings/generate/tasks').send(body)
const getTask = (taskId) => request(app).get(`/api/readings/generate/tasks/${taskId}`)

/** 轮询到终态，间隔 25 ms、上限 8 s（与 generation-task.test.js 同口径） */
async function waitForFinish(taskId, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    last = await getTask(taskId)
    if (['succeeded', 'failed', 'cancelled'].includes(last.body?.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return last
}

/** 挂起所有模型调用，用来制造「任务还在跑」的窗口 */
function deferredChat() {
  const pending = []

  chatJson.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  )

  return {
    release(payload = makePayload()) {
      for (const item of pending.splice(0)) item.resolve(reply(payload))
    },
    get size() {
      return pending.length
    },
  }
}

/** 等一个真实条件成立（不是等固定毫秒），超时返回 null 让断言失败 */
async function waitFor(check, { timeoutMs = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  return null
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('allowNewWords · 请求契约', () => {
  it('easy 不能打开生词容忍：400 且指明字段', async () => {
    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      allowNewWords: true,
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.field).toBe('allowNewWords')
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('建任务同样拦 easy + allowNewWords，且不留下任务', async () => {
    const res = await postTask({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      allowNewWords: true,
    })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('allowNewWords')
    expect(await GenerationTask.countDocuments({})).toBe(0)
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('allowNewWords 必须是布尔值', async () => {
    const res = await generate({ ...MEDIUM, allowNewWords: 'yes' })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('allowNewWords')
  })

  it('不传时默认关闭：aiMeta 记 false / 预算 0', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(MEDIUM)

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.allowNewWords).toBe(false)
    expect(doc.aiMeta.unknownBudget).toBe(0)
  })
})

describe('整篇路径 · 生词预算', () => {
  it('默认关：medium 出现一个生词就要修，预算耗尽后 422', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload({ article: `${ARTICLE} Quizzical.` })))

    const res = await generate(MEDIUM)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_VALIDATION_FAILED')
    // 首次 + 两轮修正（setup 里 MAX_REPAIR_ROUNDS=2）
    expect(chatJson).toHaveBeenCalledTimes(3)

    const failure = await GenerationFailure.findOne({}).lean()
    expect(failure.allowNewWords).toBe(false)
    expect(failure.unknownBudget).toBe(0)
  })

  it('打开后 medium 放行 3 个：一次通过，生词带音标释义落库', async () => {
    await seedWords()
    chatJson.mockResolvedValue(
      reply(makePayload({ article: `${ARTICLE} Quizzical zephyrish brontide.` })),
    )

    const res = await generate({ ...MEDIUM, allowNewWords: true })

    expect(res.status).toBe(201)
    // 预算内的生词不值得再花一轮调用
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect(res.body.newWords.map((item) => item.word).sort()).toEqual([
      'brontide',
      'quizzical',
      'zephyrish',
    ])

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta).toMatchObject({
      allowNewWords: true,
      unknownBudget: 3,
      violationsCount: 3,
      repairRounds: 0,
    })
  })

  it('打开后超过 medium 的 3 个额度仍然 422', async () => {
    await seedWords()
    chatJson.mockResolvedValue(
      reply(makePayload({ article: `${ARTICLE} Quizzical zephyrish brontide crepuscule.` })),
    )

    const res = await generate({ ...MEDIUM, allowNewWords: true })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_VALIDATION_FAILED')
    expect(chatJson).toHaveBeenCalledTimes(3)
  })

  it('hard 的上限是 5，且需要一道推断题', async () => {
    await seedWords()
    const payload = makePayload({
      article: `${ARTICLE} Quizzical zephyrish brontide crepuscule farrago.`,
    })
    // hard 的题型配额：至少 1 道 inference / main_idea
    payload.questions[0] = { ...payload.questions[0], type: 'inference' }
    chatJson.mockResolvedValue(reply(payload))

    const res = await generate({ ...HARD, allowNewWords: true })

    expect(res.status).toBe(201)
    expect(res.body.newWords).toHaveLength(5)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.allowNewWords).toBe(true)
    expect(doc.aiMeta.unknownBudget).toBe(5)
  })

  it('打开只是允许：模型全用熟词也 201，newWords 为空', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate({ ...MEDIUM, allowNewWords: true })

    expect(res.status).toBe(201)
    expect(res.body.newWords).toEqual([])

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.allowNewWords).toBe(true)
    expect(doc.aiMeta.violationsCount).toBe(0)
  })
})

describe('任务 · 参数与幂等', () => {
  it('params 回显 allowNewWords；开关不同不复用正在跑的任务', async () => {
    await seedWords()
    const gate = deferredChat()

    const first = await postTask({ ...MEDIUM, allowNewWords: true })

    expect(first.status).toBe(202)
    expect(first.body.params.allowNewWords).toBe(true)

    // 参数只差一个开关，也是两个不同的请求：不能把「按 0 预算生成」的任务复用给打开开关的人
    const second = await postTask(MEDIUM)

    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('TASK_IN_PROGRESS')
    expect(second.body.error.details.taskId).toBe(first.body.taskId)

    // 等第一次模型调用真的发出去了再放行：否则 release 时挂起队列还是空的
    expect(await waitFor(() => gate.size > 0)).toBe(true)

    gate.release()
    const done = await waitForFinish(first.body.taskId)
    expect(done.body.status).toBe('succeeded')

    const article = await Reading.findById(done.body.readingId).lean()
    expect(article.aiMeta.allowNewWords).toBe(true)
  })
})
