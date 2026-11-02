import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 冷启动（md/39）：个人词库为空时，100 / 200 词仍可生成，300 词起要求个人词库。
 *
 * 走真实路由 + 真实 service，只打桩上游模型。
 * 断言的数字必须与 `capacity-table.js` 同一套函数算出来的值一致——
 * 预检说能、点下去 422 的分叉正是这里最该防的。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { basicWordsByLevel } = await import('../modules/readings/basic-words.js')
const { calendarWords } = await import('../modules/readings/calendar-words.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 基础词 600 ∪ 日历词，即「一个个人词都没有」时的 knownWords */
const BASE_UNION = new Set([...basicWordsByLevel.easy, ...calendarWords]).size

/** 只用基础词表里的词 + 声明的人名，保证 0 词用户也能过词汇校验 */
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
    type: index === 2 ? 'inference' : 'detail',
    evidence: 'Tom is a good boy.',
    options: ['Tom', 'book', 'house', 'friends'],
    correctAnswer: 0,
    explanation: '根据文章内容可知。',
  })),
}

const reply = {
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
}

const seedWords = (count) =>
  Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )

const capacity = (query) => request(app).get('/api/readings/capacity').query(query)
const generate = (body) => request(app).post('/api/readings/generate').send(body)

beforeEach(() => {
  chatJson.mockReset()
  chatJson.mockResolvedValue(reply)
})

describe('冷启动 · /capacity', () => {
  it('0 词用户：三档的 100 / 200 都可用，300 起 blockedBy=known_words', async () => {
    const res = await capacity({ targetWords: 100 })

    expect(res.status).toBe(200)
    expect(res.body.personalWords).toBe(0)
    expect(res.body.knownWords).toBe(BASE_UNION)

    for (const level of ['easy', 'medium', 'hard']) {
      const item = res.body.levels[level]

      // 冷启动不挑目标词 → required / sufficient 与最终模式同口径，前端不会灰掉按钮
      expect(item.coldStart).toBe(true)
      expect(item.required).toBe(0)
      expect(item.sufficient).toBe(true)
      expect(item.shortage).toBe(0)
      expect(item.minKnown).toBe(BASE_UNION)

      const lengths = item.lengths

      expect(lengths[0]).toMatchObject({ targetWords: 100, unlocked: true, blockedBy: null })
      expect(lengths[1]).toMatchObject({ targetWords: 200, unlocked: true, blockedBy: null })
      expect(lengths[2]).toMatchObject({ targetWords: 300, blockedBy: 'known_words' })
    }

    // md/57：300 词起门槛是 3N = 900，缺口 900 − 618 = 282
    expect(res.body.levels.easy.lengths[2].shortage).toBe(282)
  })

  it('请求 300 词时不再是冷启动：required / sufficient 回到真实数字', async () => {
    const res = await capacity({ targetWords: 300 })

    expect(res.body.levels.easy.coldStart).toBe(false)
    expect(res.body.levels.easy.required).toBe(86)
    expect(res.body.levels.easy.sufficient).toBe(false)
    expect(res.body.levels.easy.shortage).toBe(86)
  })

  it('标过「不认识」的用户不会被冷启动地板卡住（md/56 §18）', async () => {
    // 两个基础词进了墓碑表：knownWords 只有 616，全量地板 618 会永远差 2 个
    await Word.insertMany([
      { userId: config.defaultUserId, word: 'water', status: 'new', source: 'basic-removed' },
      { userId: config.defaultUserId, word: 'tree', status: 'new', source: 'basic-removed' },
    ])

    const res = await capacity({ targetWords: 100 })

    expect(res.body.knownWords).toBe(BASE_UNION - 2)
    expect(res.body.levels.easy.minKnown).toBe(BASE_UNION - 2)
    expect(res.body.levels.easy.lengths[0]).toMatchObject({ unlocked: true, blockedBy: null })
    expect(res.body.levels.hard.lengths[0]).toMatchObject({ unlocked: true, blockedBy: null })
  })

  it('自己加的 status=new 词不算「不认识」，不减基础词池（md/56 §18）', async () => {
    await Word.insertMany([
      { userId: config.defaultUserId, word: 'water', status: 'new', source: 'manual' },
    ])

    const res = await capacity({ targetWords: 100 })

    // 减法项只认墓碑；按 status 判的话这里会变成 BASE_UNION - 1
    expect(res.body.knownWords).toBe(BASE_UNION)
  })

  it('个人词库够覆盖目标词的用户不触发冷启动', async () => {
    await seedWords(400)

    const res = await capacity({ targetWords: 100 })

    expect(res.body.levels.easy.coldStart).toBe(false)
    // 个人词足够时口径不变：100 词 easy 要 618 + 29 = 647
    expect(res.body.levels.easy.minKnown).toBe(BASE_UNION + 29)
  })
})

describe('冷启动 · 生成', () => {
  it('0 词 + easy 100 → 201，没有目标词，aiMeta.coldStart=true', async () => {
    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)
    expect(res.body.id).toBeTruthy()
    expect(chatJson).toHaveBeenCalledTimes(1)

    const doc = await Reading.findById(res.body.id).lean()

    expect(doc.targetPlan.requiredWords).toBe(0)
    expect(doc.targetPlan.focusWords).toEqual([])
    expect(doc.vocabularySnapshot).toEqual([])
    expect(doc.aiMeta.coldStart).toBe(true)
    expect(doc.aiMeta.finalMode).toBe(false)
    expect(doc.aiMeta.minKnown).toBe(BASE_UNION)
  })

  it('标过「不认识」的 0 词用户 + easy 100 → 201', async () => {
    await Word.insertMany([
      { userId: config.defaultUserId, word: 'water', status: 'new', source: 'basic-removed' },
      { userId: config.defaultUserId, word: 'tree', status: 'new', source: 'basic-removed' },
    ])

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)
    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.minKnown).toBe(BASE_UNION - 2)
  })

  it('0 词 + hard 200 → 201（200 是冷启动上限）', async () => {
    const res = await generate({ level: 'hard', targetWords: 200, questionCount: 3 })

    expect(res.status).toBe(201)
  })

  it('0 词 + 300 → 422 INSUFFICIENT_VOCABULARY（300 起要先有自己的词）', async () => {
    const res = await generate({ level: 'easy', targetWords: 300, questionCount: 3 })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INSUFFICIENT_VOCABULARY')
    expect(chatJson).not.toHaveBeenCalled()
    expect(await Reading.countDocuments()).toBe(0)
  })

  it('已有 20 个词但不够 300 词：300 报 known_words，100/200 仍可写', async () => {
    await seedWords(20)

    const tooLong = await generate({ level: 'hard', targetWords: 300, questionCount: 3 })

    expect(tooLong.status).toBe(422)
    expect(tooLong.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    expect(tooLong.body.error.details).toMatchObject({
      kind: 'known_words',
      level: 'hard',
      targetWords: 300,
      required: 900,
      available: 20 + BASE_UNION,
    })
    expect(chatJson).not.toHaveBeenCalled()

    const ok = await generate({ level: 'hard', targetWords: 200, questionCount: 3 })

    expect(ok.status).toBe(201)
  })
})
