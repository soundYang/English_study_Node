import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * W6 扩写轮。
 *
 * `setup.js` 把 MAX_EXPAND_ROUNDS 固定为 0（默认关）。这个文件要验证**开启后**的行为，
 * 所以必须在 config 被导入之前改环境变量——下面一律用动态 import，静态 import 会
 * 在模块体之前求值，环境变量就白设了。
 */
process.env.MAX_EXPAND_ROUNDS = '1'
process.env.GENERATION_STRATEGY = 'whole'

const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 40 词：100 词请求的验收下限是 85，所以首轮必被判 short */
const SHORT_ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

/** 90 词：落在 85–115 之间，扩写一轮后应为 ok */
const EXPANDED_ARTICLE = `${SHORT_ARTICLE} ${SHORT_ARTICLE} Tom is a good boy and his book is good.`

function makePayload({ article = SHORT_ARTICLE, questionCount = 3 } = {}) {
  return {
    title: 'A Good Day',
    article,
    // 翻译有最短长度要求（20 字）；写短了会先触发结构修正，测不到扩写
    translation: '汤姆是个好男孩。他喜欢和他的书在公园里玩。书跑得快，汤姆也跑得快。他们一整天都很开心。开心的一天。',
    names: ['Tom'],
    questions: Array.from({ length: questionCount }, (_, index) => ({
      id: index + 1,
      question: `Question number ${index + 1} about the story?`,
      // W7：evidence 必须是正文里的句子；detail 答案与 evidence 的重合度只记警告，不再阻断
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

function seedWords(count) {
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

const generate = (body) => request(app).post('/api/readings/generate').send(body)

const VALID_BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

beforeEach(() => {
  chatJson.mockReset()
})

describe('POST /api/readings/generate · 偏短扩写（MAX_EXPAND_ROUNDS=1）', () => {
  it('首轮偏短 → 追加一轮扩写 → 201 且 lengthStatus=ok', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload()))
      .mockResolvedValueOnce(reply(makePayload({ article: EXPANDED_ARTICLE })))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)

    const messages = chatJson.mock.calls[1][0].messages
    const instruction = messages.at(-1).content
    expect(instruction).toContain('偏短')
    expect(instruction).toContain('补写 3 个英文句子') // 40 词 → 目标 110，差 70 词，封顶 3 句
    // 扩写必须以原稿为锚点：带上模型上一轮的完整输出
    const assistant = messages.find((message) => message.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant.content).toContain('A Good Day')

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.actualWords).toBe(90)
    expect(doc.aiMeta.lengthStatus).toBe('ok')
    expect(doc.aiMeta.repairRounds).toBe(1)
    expect(doc.aiMeta.rounds.map((round) => round.kind)).toEqual(['generate', 'repair'])
    expect(doc.aiMeta.rounds[0].feedbackType).toBe('word_expand')
  })

  it('扩写后仍偏短 → 只补一轮，照旧 201 并记录 short', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload())) // 两次都只有 40 词

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    // 默认只给一轮：不达标的短文章不能无限补写，也不能因此判失败
    expect(chatJson).toHaveBeenCalledTimes(2)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.actualWords).toBe(40)
    expect(doc.aiMeta.lengthStatus).toBe('short')
    expect(doc.aiMeta.repairRounds).toBe(1)
  })

  it('扩写轮不占用用词修正的额度', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload())) // 1: 40 词 → 偏短，扩写
      .mockResolvedValueOnce(reply(makePayload({ article: `${EXPANDED_ARTICLE} Quizzical.` }))) // 2: 长度达标但 1 个生词
      .mockResolvedValueOnce(reply(makePayload({ article: EXPANDED_ARTICLE }))) // 3: 修词后正常

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(3)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(2)
    expect(doc.aiMeta.rounds.map((round) => round.feedbackType)).toEqual([
      'word_expand',
      'vocabulary',
      null,
    ])
  })
})
