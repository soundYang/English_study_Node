import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 复习回写（md/21 W0）。
 *
 * 这组测试守的是一条「此前完全失效」的链路：
 *   articleExposureCount / lastArticleExposureAt / lastReviewedAt 三个字段
 *   在代码里被读、被建模，但从来没有任何地方写。
 *   结果就是 vocabScope=today_reviewed 永远是空池——
 *   用户「按今天复习的词生成文章」这条主链路从来没有真正跑通过。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 与 readings.test.js 同一篇正文：全部由基础词构成，稳定通过词汇校验 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const QUESTIONS = [
  { id: 1, question: 'Question number 1 about the story?', options: ['a', 'b', 'c', 'd'], correctAnswer: 0, explanation: '根据文章内容可知。' },
  { id: 2, question: 'Question number 2 about the story?', options: ['a', 'b', 'c', 'd'], correctAnswer: 1, explanation: '根据文章内容可知。' },
  { id: 3, question: 'Question number 3 about the story?', options: ['a', 'b', 'c', 'd'], correctAnswer: 2, explanation: '根据文章内容可知。' },
]

/**
 * 399 个填充词 + 一个真的会出现在正文里的 book = 400 个个人词。
 * easy 的已知词门是 1000：400 + 600 基础词 + 日历词（book 本身就在基础表里）。
 */
function seedWords(count = 399) {
  return Word.insertMany([
    ...Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
    {
      userId: config.defaultUserId,
      word: 'book',
      status: 'learning',
      source: 'manual',
      senses: [{ pos: 'n.', meaning: '书' }],
    },
  ])
}

function makePayload(article = ARTICLE) {
  return {
    title: 'A Good Day',
    article,
    translation:
      '汤姆是个好男孩。他的书很大，男孩很小。汤姆和他的书在房子里玩，他们是非常好的朋友。',
    names: ['Tom'],
    questions: QUESTIONS,
  }
}

const reply = (payload) => ({
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

const makeReading = (overrides = {}) =>
  Reading.create({
    userId: config.defaultUserId,
    title: 'A Good Day',
    article: ARTICLE,
    translation: '汤姆是个好男孩。',
    level: 'easy',
    targetWords: 100,
    questionCount: 3,
    actualWords: 40,
    questions: QUESTIONS,
    // 本篇候选池：只含 book，不含 word0
    vocabularySnapshot: ['book'],
    names: ['Tom'],
    status: 'generated',
    ...overrides,
  })

const answersOf = (...selected) =>
  QUESTIONS.map((question, index) => ({
    questionId: question.id,
    selectedOption: selected[index] ?? null,
  }))

const generate = (body) =>
  request(app).post('/api/readings/generate').send(body)

const submit = (id, body) =>
  request(app).post(`/api/readings/${id}/submit`).send(body)

const findWord = (word) =>
  Word.findOne({ userId: config.defaultUserId, word }).lean()

beforeEach(() => {
  chatJson.mockReset()
})

describe('生成 → 曝光回写', () => {
  it('正文里出现的已学词 articleExposureCount +1，未出现的不动', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const book = await findWord('book')
    expect(book.articleExposureCount).toBe(1)
    expect(book.lastArticleExposureAt).toBeInstanceOf(Date)

    const untouched = await findWord('word0')
    expect(untouched.articleExposureCount).toBe(0)
    expect(untouched.lastArticleExposureAt).toBeNull()
  })

  it('曝光不写 lastReviewedAt——看过不等于复习过', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    const book = await findWord('book')
    expect(book.lastReviewedAt).toBeNull()
  })

  it('生成失败（AI 结构不合法）不产生曝光', async () => {
    await seedWords()
    chatJson.mockResolvedValue({ content: 'not json', usage: {} })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(502)

    const book = await findWord('book')
    expect(book.articleExposureCount).toBe(0)
  })
})

describe('提交 → 复习回写', () => {
  it('只把「候选池 ∩ 正文」的词标记为已复习', async () => {
    await seedWords()
    // word1 在候选池里，但正文里没有；word0 两样都不沾
    const reading = await makeReading({ vocabularySnapshot: ['book', 'word1'] })

    const res = await submit(reading._id, { answers: answersOf(0, 1, 2) })

    expect(res.status).toBe(200)

    const book = await findWord('book')
    expect(book.lastReviewedAt).toBeInstanceOf(Date)

    expect((await findWord('word1')).lastReviewedAt).toBeNull()
    expect((await findWord('word0')).lastReviewedAt).toBeNull()
  })

  it('词形还原：正文写 dogs，词库存 dog，也算复习到', async () => {
    await seedWords()
    await Word.create({
      userId: config.defaultUserId,
      word: 'dog',
      status: 'learning',
      source: 'manual',
      senses: [{ pos: 'n.', meaning: '狗' }],
    })

    const reading = await makeReading({
      article: 'The dogs run in the park.',
      vocabularySnapshot: ['dog'],
    })

    const res = await submit(reading._id, { answers: answersOf(0, 1, 2) })

    expect(res.status).toBe(200)
    expect((await findWord('dog')).lastReviewedAt).toBeInstanceOf(Date)
  })

  it('未提交的文章不产生 lastReviewedAt', async () => {
    await seedWords()
    await makeReading()

    expect((await findWord('book')).lastReviewedAt).toBeNull()
  })

  it('重复提交 409，且不会二次写复习时间', async () => {
    await seedWords()
    const reading = await makeReading()

    await submit(reading._id, { answers: answersOf(0, 1, 2) })

    // 先把时间改成一个人为哨兵值，第二次提交如果真的写了，就会覆盖它
    const sentinel = new Date('2020-01-01T00:00:00.000Z')
    await Word.updateOne(
      { userId: config.defaultUserId, word: 'book' },
      { $set: { lastReviewedAt: sentinel } },
    )

    const res = await submit(reading._id, { answers: answersOf(0, 1, 2) })

    expect(res.status).toBe(409)
    expect((await findWord('book')).lastReviewedAt).toEqual(sentinel)
  })
})

describe('端到端 · today_reviewed 不再永远是空池', () => {
  it('提交前 available=0，提交后 capacity 能查到这篇练过的词', async () => {
    await seedWords()
    const reading = await makeReading()

    const before = await request(app)
      .get('/api/readings/capacity')
      .query({ targetWords: 100, vocabScope: 'today_reviewed' })

    expect(before.status).toBe(200)
    expect(before.body.available).toBe(0)

    await submit(reading._id, { answers: answersOf(0, 1, 2) })

    const after = await request(app)
      .get('/api/readings/capacity')
      .query({ targetWords: 100, vocabScope: 'today_reviewed' })

    expect(after.status).toBe(200)
    expect(after.body.available).toBe(1)
  })
})
