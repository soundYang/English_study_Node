import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P3 选池的集成测试：走真实路由 + 真实 service，只打桩上游模型。
 * 与 vocabulary-pool.test.js 的分工：
 *   那边测纯函数的数字，这边测「数字有没有真的走到 HTTP 和落库」。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 只用基础 600 词 + 声明的人名，保证过得了词汇校验 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const payload = {
  title: 'A Good Day',
  article: ARTICLE,
  translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
  names: ['Tom'],
  questions: Array.from({ length: 3 }, (_, index) => ({
    id: index + 1,
    question: `Question number ${index + 1} about the story?`,
    options: ['Tom', 'A book', 'A house', 'A day'].map((option) => `${option} ${index + 1}`),
    correctAnswer: index % 4,
    explanation: '根据文章内容可知。',
  })),
}

const reply = { content: JSON.stringify(payload), usage: { prompt_tokens: 100, completion_tokens: 200 } }

const seedWords = (count, prefix = 'word') =>
  Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `${prefix}${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )

const generate = (body) => request(app).post('/api/readings/generate').send(body)

beforeEach(() => {
  chatJson.mockReset()
})

describe('词量不足以支撑篇幅', () => {
  it('45 个词 + hard + 800 → 422，并带回差额', async () => {
    await seedWords(45)

    const res = await generate({ level: 'hard', targetWords: 800, questionCount: 3 })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    expect(res.body.error.field).toBe('targetWords')
    expect(res.body.error.details).toEqual({
      required: 115,
      available: 45,
      requiredWords: 80,
      targetWords: 800,
      scope: ['all'],
      level: 'hard',
    })
    expect(res.body.error.message).toContain('还差 70 个')
    // 注定凑不出目标词数，一次模型都不该调
    expect(chatJson).not.toHaveBeenCalled()
    expect(await Reading.countDocuments()).toBe(0)
  })

  it('同样 45 个词，缩短篇幅就能通过闸门', async () => {
    await seedWords(45)
    chatJson.mockResolvedValue(reply)

    // 100 词 hard：目标词 10 个，门槛 ceil(10 ÷ 0.7) = 15 个，45 够用
    const res = await generate({ level: 'hard', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)
  })
})

describe('候选池与目标词计划', () => {
  it('200 个词 + hard + 800 → 池子取 70% 得 140 个', async () => {
    await seedWords(200)
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'hard', targetWords: 800, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.vocabularySnapshot).toHaveLength(140)
    expect(doc.targetPlan.poolSize).toBe(140)
    expect(doc.targetPlan.requiredWords).toBe(80)
    expect(doc.targetPlan.focusWords).toHaveLength(28)
    expect(doc.targetPlan.scope).toEqual(['all'])
    expect(doc.aiMeta.candidatePoolSize).toBe(140)
    expect(doc.aiMeta.requiredWords).toBe(80)
  })

  it('候选池只会更小，不会因为词库大就按 createdAt 截断', async () => {
    // 1200 个词，hard 取 70% = 840 → 封顶 800
    await seedWords(1200)
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'hard', targetWords: 800, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.targetPlan.poolSize).toBe(800)
  })
})

describe('词源筛选', () => {
  it('vocabScope=today_new 时只从今天新增的词里取', async () => {
    await seedWords(200, 'old')
    // 时间戳由 Mongoose 自动写入，绕过它把老词挪到过去
    await Word.collection.updateMany(
      { userId: config.defaultUserId },
      { $set: { createdAt: new Date('2020-01-01T00:00:00Z') } },
    )
    await seedWords(3, 'fresh')

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      vocabScope: ['today_new'],
    })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    // 总词数 203 过了 20 的闸门，卡在 scope 过滤之后只剩 3 个
    expect(res.body.error.details.available).toBe(3)
    expect(res.body.error.details.scope).toEqual(['today_new'])
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('空数组 → 400，field 指向 vocabScope', async () => {
    await seedWords(45)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      vocabScope: [],
    })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('vocabScope')
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('all 与其它值同时出现时按全选处理', async () => {
    await seedWords(45)
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      vocabScope: ['all', 'today_new'],
    })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.targetPlan.scope).toEqual(['all'])
  })
})
