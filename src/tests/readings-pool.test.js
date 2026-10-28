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
  it('45 个词 + hard + 600 → 422，并带回差额', async () => {
    await seedWords(45)

    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    expect(res.body.error.field).toBe('targetWords')
    expect(res.body.error.details).toEqual({
      required: 86,
      available: 45,
      requiredWords: 60,
      targetWords: 600,
      scope: ['all'],
      level: 'hard',
    })
    expect(res.body.error.message).toContain('还差 41 个')
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
  it('200 个词 + hard + 600 → 池子取 70% 得 140 个', async () => {
    await seedWords(200)
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.vocabularySnapshot).toHaveLength(140)
    expect(doc.targetPlan.poolSize).toBe(140)
    expect(doc.targetPlan.requiredWords).toBe(60)
    expect(doc.targetPlan.focusWords).toHaveLength(21)
    expect(doc.targetPlan.scope).toEqual(['all'])
    expect(doc.aiMeta.candidatePoolSize).toBe(140)
    expect(doc.aiMeta.requiredWords).toBe(60)
  })

  it('候选池只会更小，不会因为词库大就按 createdAt 截断', async () => {
    // 1200 个词，hard 取 70% = 840 → 封顶 800（POOL_LIMIT，与 targetWords 上限无关）
    await seedWords(1200)
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.targetPlan.poolSize).toBe(800)
  })
})

describe('校验词表与提示词词表分离', () => {
  it('池外但用户学过的词不算表外', async () => {
    await seedWords(200)
    // cocaRank 极大 → easy 按排名升序取前 71 个，这个词必然落在池外
    await Word.create({
      userId: config.defaultUserId,
      word: 'zephyrous',
      status: 'learning',
      source: 'manual',
      cocaRank: 99999,
      senses: [{ pos: '', meaning: '测试释义' }],
    })
    chatJson.mockResolvedValue({
      ...reply,
      content: JSON.stringify({ ...payload, article: `${ARTICLE} Zephyrous.` }),
    })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    // 旧行为：这个词不在候选池里 → 422 VOCABULARY_VALIDATION_FAILED
    expect(res.status).toBe(201)

    // 它确实没进提示词（提示词只列候选池）……
    const prompt = chatJson.mock.calls[0][0].messages[1].content
    expect(prompt).not.toContain('zephyrous')

    // ……但校验放行了，因为用户本来就学过
    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.vocabularySnapshot).not.toContain('zephyrous')
  })

  it('超过额度的真正生词仍然要被拦下', async () => {
    await seedWords(200)
    // 6 个 > maxUnknownWords(5)：才会进入修正轮，两轮后仍超额 → 422
    const unknown = 'Quizzical zephyrish brontide crepuscule farrago panopticon.'
    chatJson.mockResolvedValue({
      ...reply,
      content: JSON.stringify({ ...payload, article: `${ARTICLE} ${unknown}` }),
    })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_VALIDATION_FAILED')
  })
})

describe('生成前预检 GET /capacity', () => {
  const capacity = (query) => request(app).get('/api/readings/capacity').query(query)

  it('200 词时返回三档门槛与预计篇幅', async () => {
    await seedWords(200)

    const res = await capacity({ targetWords: 200 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      targetWords: 200,
      available: 200,
      maxUnknownWords: 5,
      wordRange: { min: 200, target: 220, max: 230, label: '200–230 词' },
      acceptedRange: { min: 170, target: 220, max: 230, label: '170–230 词' },
      levels: {
        easy: { required: 58, sufficient: true, shortage: 0 },
        medium: { required: 40, sufficient: true, shortage: 0 },
        hard: { required: 29, sufficient: true, shortage: 0 },
      },
    })
  })

  it('词量不够时给出差额，且与真实闸门同数字', async () => {
    await seedWords(45)

    const res = await capacity({ targetWords: 600 })

    expect(res.body.levels.hard).toEqual({ required: 86, sufficient: false, shortage: 41 })

    // 同一组参数真的去生成，422 里回的数字必须一致
    const rejected = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })
    expect(rejected.status).toBe(422)
    expect(rejected.body.error.details.required).toBe(res.body.levels.hard.required)
    expect(rejected.body.error.details.available).toBe(res.body.available)
  })

  it('单个 vocabScope 写成字符串也能收', async () => {
    await seedWords(200)

    const res = await capacity({ targetWords: 200, vocabScope: 'today_new' })

    expect(res.status).toBe(200)
    // 刚建的 200 个词本来就落在今天，所以够用
    expect(res.body.levels.hard.sufficient).toBe(true)
  })

  it('非法 vocabScope → 400，field 指向 vocabScope', async () => {
    await seedWords(200)

    const res = await capacity({ targetWords: 200, vocabScope: 'bogus' })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('vocabScope')
  })

  it('targetWords 不合法 → 400，field 指向 targetWords', async () => {
    await seedWords(200)

    const res = await capacity({ targetWords: 55 })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('targetWords')
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
