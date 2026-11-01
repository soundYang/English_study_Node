import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P2：文章用词清单与交卷回写（md/56 §4.2 / §6）。
 *
 * 生成路径照 readings.test.js 的做法把上游打桩；交卷与批量自评直接建文档，
 * 因为这里要验的是「拿到了 usedWords 之后怎么记账」，不是怎么生成出来的。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')
const { MASTER_STAGE } = await import('../modules/words/review-schedule.js')
const { countWordForms } = await import('../modules/readings/vocabulary.service.js')

const app = createApp()
const uid = config.defaultUserId

const generate = (body) => request(app).post('/api/readings/generate').send(body)
const submit = (id, body) => request(app).post(`/api/readings/${id}/submit`).send(body)
const reviewBatch = (items) => request(app).post('/api/words/review/batch').send({ items })

/**
 * abandon 恰好出现两次（focus 的复现要求是 2–3 次），其余都是 easy 基础词。
 * 篇幅沿用 readings.test.js 那份 40 词的正文骨架——它在 easy 档验证过能过篇幅校验。
 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. He abandons the book. Tom abandons the big book. They are good friends.'

const QUESTIONS = [
  { id: 1, question: 'Question number 1 about the story?', type: 'detail', evidence: 'Tom is a good boy.', options: ['a', 'b', 'c', 'd'], correctAnswer: 0, explanation: '解析1' },
  { id: 2, question: 'Question number 2 about the story?', type: 'detail', evidence: 'Tom is a good boy.', options: ['a', 'b', 'c', 'd'], correctAnswer: 1, explanation: '解析2' },
  { id: 3, question: 'Question number 3 about the story?', type: 'detail', evidence: 'Tom is a good boy.', options: ['a', 'b', 'c', 'd'], correctAnswer: 2, explanation: '解析3' },
]

const ANSWERS = { answers: QUESTIONS.map((q) => ({ questionId: q.id, selectedOption: q.correctAnswer })) }

/**
 * easy 的个人词库下限是 400（readings.test.js 同一套口径）。
 * `abandon` 放在第一位，其余用 word1…word399 占位——它们不会出现在正文里，
 * 不会被算进 usedWords。
 */
function seedWords(count = 400, extra = {}) {
  return Word.insertMany([
    {
      userId: uid,
      word: 'abandon',
      status: 'learning',
      source: 'manual',
      senses: [{ pos: 'v', meaning: '放弃' }],
      ...extra,
    },
    ...Array.from({ length: count - 1 }, (_, index) => ({
      userId: uid,
      word: `word${index + 1}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  ])
}

function makePayload() {
  return {
    title: 'The Good Boy',
    article: ARTICLE,
    translation:
      '汤姆是个好男孩。他的书很大，而这个男孩很小。汤姆和他的书在屋子里玩。他放弃了那本书。汤姆放弃了那本大书。他们是好朋友。',
    names: ['Tom'],
    questions: QUESTIONS.map((question) => ({
      ...question,
      evidence: 'Tom is a good boy.',
      options: ['Tom', 'book', 'boy', 'small'],
    })),
  }
}

const reply = (payload) => ({
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

function makeReading(overrides = {}) {
  return Reading.create({
    userId: uid,
    title: 'A Good Day',
    article: ARTICLE,
    translation: '汤姆是个好男孩。',
    level: 'easy',
    targetWords: 100,
    questionCount: 3,
    actualWords: 20,
    questions: QUESTIONS,
    vocabularySnapshot: ['abandon', 'ancient', 'bridge'],
    names: ['Tom'],
    status: 'generated',
    ...overrides,
  })
}

const seedWord = (doc) =>
  Word.create({
    userId: uid,
    source: 'manual',
    status: 'learning',
    senses: [{ pos: '', meaning: '测试释义' }],
    ...doc,
  })

const findWord = (word) => Word.findOne({ userId: uid, word })

beforeEach(() => {
  chatJson.mockReset()
})

describe('countWordForms', () => {
  it('按出现次数统计，只算候选词', () => {
    const counts = countWordForms('Abandon it. He abandons nothing.', ['abandon'])

    expect(counts.get('abandon')).toBe(2)
    expect(counts.has('it')).toBe(false)
  })

  it('同一个 token 的多种还原形式不会把同一个候选词记成两次', () => {
    // abandoned 既直接命中，又能还原到原形 abandon。
    // 若按「形式」累加，候选词 abandon 会被记成 2 次，而它只出现了一次
    const counts = countWordForms('He abandoned it.', ['abandon'])

    expect(counts.get('abandon')).toBe(1)
  })

  it('一个 token 还原出两个候选词时，两个都记一次', () => {
    // ran 既是候选词本身，又还原成 run；这是两个词，各算一次出现
    const counts = countWordForms('He ran home.', ['ran', 'run'])

    expect(counts.get('ran')).toBe(1)
    expect(counts.get('run')).toBe(1)
  })

  it('候选词为空时返回空 Map，不扫正文', () => {
    expect(countWordForms('anything at all', []).size).toBe(0)
  })
})

describe('生成时落库 usedWords', () => {
  it('存下 word / count / kind，并把显式选中的词标成 focus', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['abandon'],
    })

    expect(res.status).toBe(201)
    expect(res.body.usedWords).toEqual([{ word: 'abandon', count: 2, kind: 'focus' }])

    const saved = await Reading.findById(res.body.id).lean()
    expect(saved.usedWords.map((item) => item.word)).toEqual(['abandon'])
    expect(saved.usedWords[0].count).toBe(2)
    expect(saved.usedWords[0].kind).toBe('focus')
  })

  it('详情接口带回 usedWords，老文档回空数组', async () => {
    const withWords = await makeReading({
      usedWords: [{ word: 'abandon', count: 2, kind: 'focus' }],
    })
    const without = await makeReading({ title: 'old' })

    const a = await request(app).get(`/api/readings/${withWords._id}`)
    const b = await request(app).get(`/api/readings/${without._id}`)

    expect(a.body.usedWords).toEqual([{ word: 'abandon', count: 2, kind: 'focus' }])
    expect(b.body.usedWords).toEqual([])
  })
})

describe('交卷回写（md/56 §6.2）', () => {
  it('focus / target 推进轮次，pool 只更新复习时间', async () => {
    await seedWord({ word: 'abandon' })
    await seedWord({ word: 'ancient', reviewStage: 1 })
    await seedWord({ word: 'bridge', reviewStage: 1 })

    const reading = await makeReading({
      usedWords: [
        { word: 'abandon', count: 2, kind: 'focus' },
        { word: 'ancient', count: 1, kind: 'target' },
        { word: 'bridge', count: 3, kind: 'pool' },
      ],
    })

    const res = await submit(reading._id, ANSWERS)
    expect(res.status).toBe(200)

    const abandoned = await findWord('abandon')
    expect(abandoned.reviewStage).toBe(1)
    expect(abandoned.nextReviewAt).not.toBeNull()

    // ancient 原本第 1 轮，再通过一次就到掌握线
    const ancient = await findWord('ancient')
    expect(ancient.status).toBe('mastered')
    expect(ancient.nextReviewAt).toBeNull()
    expect(ancient.masteredAt).not.toBeNull()

    // pool 词：只记复习时间，轮次一动不动
    const bridge = await findWord('bridge')
    expect(bridge.reviewStage).toBe(1)
    expect(bridge.lastReviewedAt).not.toBeNull()
  })

  it('已掌握的词不再往上加轮次', async () => {
    await seedWord({ word: 'abandon', status: 'mastered', reviewStage: MASTER_STAGE })

    const reading = await makeReading({
      usedWords: [{ word: 'abandon', count: 2, kind: 'focus' }],
    })

    await submit(reading._id, ANSWERS)

    const doc = await findWord('abandon')
    expect(doc.status).toBe('mastered')
    expect(doc.reviewStage).toBe(MASTER_STAGE)
    expect(doc.lastReviewedAt).not.toBeNull()
  })

  it('基础词墓碑即使被用进文章也不会被复活', async () => {
    await seedWord({ word: 'abandon', status: 'new', source: 'basic-removed' })

    const reading = await makeReading({
      usedWords: [{ word: 'abandon', count: 2, kind: 'target' }],
    })

    await submit(reading._id, ANSWERS)

    const doc = await findWord('abandon')
    expect(doc.status).toBe('new')
    expect(doc.reviewStage).toBe(0)
    expect(doc.nextReviewAt).toBeNull()
  })

  it('P2 之前的老文章没有 usedWords，按 pool 处理，不补轮次', async () => {
    await seedWord({ word: 'abandon', reviewStage: 1 })

    // budget 里没有 usedWords 字段，靠 schema 的默认值落下空数组
    const reading = await makeReading()

    await submit(reading._id, ANSWERS)

    const doc = await findWord('abandon')
    expect(doc.reviewStage).toBe(1)
    expect(doc.lastReviewedAt).not.toBeNull()
  })
})

describe('POST /api/words/review/batch', () => {
  it('一次提交多个自评，全部推进', async () => {
    const a = await seedWord({ word: 'one' })
    const b = await seedWord({ word: 'two', reviewStage: 1 })

    const res = await reviewBatch([
      { id: String(a._id), result: 'pass' },
      { id: String(b._id), result: 'pass' },
    ])

    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(2)
    expect(res.body.skipped).toEqual([])
    expect(res.body.words).toHaveLength(2)

    expect((await findWord('one')).reviewStage).toBe(1)
    expect((await findWord('two')).status).toBe('mastered')
  })

  it('「没记住」轮次归零、计数 +1', async () => {
    const doc = await seedWord({ word: 'forgot', reviewStage: 2, lapseCount: 1 })

    const res = await reviewBatch([{ id: String(doc._id), result: 'lapse' }])

    expect(res.status).toBe(200)

    const saved = await findWord('forgot')
    expect(saved.reviewStage).toBe(0)
    expect(saved.lapseCount).toBe(2)
    expect(saved.status).toBe('learning')
  })

  it('不存在的词进 skipped，不拖垮同批其它词', async () => {
    const ok = await seedWord({ word: 'ok' })

    const res = await reviewBatch([
      { id: '66f000000000000000000000', result: 'pass' },
      { id: 'not-an-id', result: 'pass' },
      { id: String(ok._id), result: 'pass' },
    ])

    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(1)
    expect(res.body.skipped).toEqual([
      { id: '66f000000000000000000000', reason: 'NOT_FOUND' },
      { id: 'not-an-id', reason: 'NOT_FOUND' },
    ])
    expect((await findWord('ok')).reviewStage).toBe(1)
  })

  it('墓碑词进 skipped，不会被自评复活', async () => {
    const tomb = await seedWord({ word: 'tomb', status: 'new', source: 'basic-removed' })

    const res = await reviewBatch([{ id: String(tomb._id), result: 'pass' }])

    expect(res.body.updated).toBe(0)
    expect(res.body.skipped).toEqual([{ id: String(tomb._id), reason: 'BASIC_REMOVED' }])

    const saved = await findWord('tomb')
    expect(saved.status).toBe('new')
    expect(saved.reviewStage).toBe(0)
  })

  it('同一个 id 传两次只推进一轮', async () => {
    const doc = await seedWord({ word: 'twice' })

    const res = await reviewBatch([
      { id: String(doc._id), result: 'lapse' },
      { id: String(doc._id), result: 'pass' },
    ])

    expect(res.body.updated).toBe(1)
    expect((await findWord('twice')).reviewStage).toBe(1)
  })

  it('空数组 / 缺字段 / 非法 result 都报 400', async () => {
    expect((await reviewBatch([])).status).toBe(400)
    expect((await reviewBatch([{ id: 'x' }])).status).toBe(400)
    expect((await reviewBatch([{ id: 'x', result: 'maybe' }])).status).toBe(400)
  })

  it('超过 200 条报 400', async () => {
    const items = Array.from({ length: 201 }, () => ({ id: 'not-an-id', result: 'pass' }))

    expect((await reviewBatch(items)).status).toBe(400)
  })
})
