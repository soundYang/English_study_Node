import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 失败样本留痕（方案 §3.1）。
 *
 * 这里测的**不是**生成质量，而是「失败之后能不能解释」：
 * 每一个非成功返回都要在场，且带着那一轮的违规词、选池数字和原始正文。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { GenerationFailure } = await import('../modules/readings/generation-failure.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

/** 6 个必然不在词表里的词：超过 maxUnknownWords(5)，才会进入修正轮 */
const OVER_LIMIT_ARTICLE = `${ARTICLE} Quizzical Zephyrish Brontide Crepuscule Farrago Panopticon.`

/** 160 词：超过 easy/100 的篇幅上限（115），用来把重写额度耗光 */
const LONG_ARTICLE = Array.from({ length: 4 }, () => ARTICLE).join(' ')

/** 造一份合法的 AI 输出 */
function makePayload({ questionCount = 3, article = ARTICLE } = {}) {
  return {
    title: 'A Good Day',
    article,
    // zod 要求 translation 至少 20 字，短了会被判成结构不合法，测不到生成分支
    translation:
      '汤姆是个好男孩。他喜欢和他的书在公园里玩。书很有趣，汤姆也很快乐。他们一整天都很开心。开心的一天。',
    names: ['Tom'],
    questions: Array.from({ length: questionCount }, (_, index) => ({
      id: index + 1,
      question: `Question number ${index + 1} about the story?`,
      options: ['Tom', 'A dog', 'A park', 'A day'].map((option) => `${option} ${index + 1}`),
      correctAnswer: index % 4,
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

describe('生成失败留痕 · 只有生成流程内的失败才入库', () => {
  it('参数非法 → 400 且不写 GenerationFailure', async () => {
    const res = await generate({ level: 'insane', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(400)
    // 每条非法请求都存一份会把真实样本淹掉，所以这条必须为 0
    expect(await GenerationFailure.countDocuments()).toBe(0)
  })

  it('候选池不够 → 422 且留痕，带选池数字但没有模型轮次', async () => {
    await seedWords(45)

    // hard + 600 词：目标词 60，门槛 ceil(60 ÷ 0.7) = 86 > 45
    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    expect(chatJson).not.toHaveBeenCalled()

    const [failure] = await GenerationFailure.find().lean()
    expect(await GenerationFailure.countDocuments()).toBe(1)
    expect(failure.errorCode).toBe('VOCABULARY_TOO_SMALL')
    expect(failure.level).toBe('hard')
    expect(failure.targetWords).toBe(600)
    expect(failure.available).toBe(45)
    expect(failure.requiredWords).toBe(60)
    // 一次模型都没调，轮次为空是正确结果，不是丢数据
    expect(failure.rounds).toHaveLength(0)
    expect(failure.finalArticle).toBe('')
  })

  it('修正轮耗尽仍有 6 个生词 → 422 且每轮违规词都留下来了', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload({ article: OVER_LIMIT_ARTICLE })))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_VALIDATION_FAILED')
    // 首轮 + 两轮修正
    expect(chatJson).toHaveBeenCalledTimes(3)

    const [failure] = await GenerationFailure.find().lean()
    expect(failure.errorCode).toBe('VOCABULARY_VALIDATION_FAILED')
    expect(failure.repairRounds).toBe(2)
    expect(failure.finalUnknownWords).toHaveLength(6)
    expect(failure.finalArticle).toContain('Quizzical')
    expect(failure.allowedWordCount).toBeGreaterThan(0)
    expect(failure.promptWordCount).toBeGreaterThan(0)

    expect(failure.rounds).toHaveLength(3)
    // 首轮没有上游原因，但它自己判出的是用词问题
    expect(failure.rounds[0]).toMatchObject({ kind: 'generate', repairFor: null, feedbackType: 'vocabulary' })
    expect(failure.rounds[0].unknownWords).toHaveLength(6)
    // 分类要当场落库。6 个词都没排名，但只有句首的 Quizzical 算生造词，
    // 后面 5 个是句中大写——按规则判成专名，这正是 counts 与 violations 一致的意思
    expect(failure.rounds[0].counts).toMatchObject({ proper_noun: 5, unknown_token: 1 })
    const counted = Object.values(failure.rounds[0].counts).reduce((a, b) => a + b, 0)
    expect(counted).toBe(failure.rounds[0].unknownWords.length)
    // 后两轮是被用词问题催出来的
    expect(failure.rounds[1]).toMatchObject({ kind: 'repair', repairFor: 'vocabulary', feedbackType: 'vocabulary' })
    expect(failure.rounds[2].unknownWords).toHaveLength(6)
  })

  it('结构一直不合法 → 502 且存的是模型原始输出', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue({ content: '当然可以！这是文章：Tom is a boy.' })

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE')

    const [failure] = await GenerationFailure.find().lean()
    expect(failure.errorCode).toBe('AI_INVALID_RESPONSE')
    // 结构不合法时没有 data.article，退回原始输出才能分清「截断」和「格式错」
    expect(failure.finalArticle).toContain('当然可以')
    expect(failure.rounds).toHaveLength(3)
    expect(failure.rounds[0].feedbackType).toBe('structure')
    expect(failure.rounds[1].repairFor).toBe('structure')
    expect(failure.rounds[0].unknownWords).toEqual([])
  })

  it('成功一次 → 不写 GenerationFailure，但 aiMeta.rounds 同样带诊断字段', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(await GenerationFailure.countDocuments()).toBe(0)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.rounds).toHaveLength(1)
    // feedbackType 是「这一轮自己判出什么」，不是「因此一定又调了一次」：
    // 40 词对 100 词请求必然偏短，默认 MAX_EXPAND_ROUNDS=0 时只标 word_expand、不补写
    expect(doc.aiMeta.rounds[0]).toMatchObject({
      kind: 'generate',
      repairFor: null,
      feedbackType: 'word_expand',
    })
    expect(doc.aiMeta.rounds[0].unknownWords).toEqual([])
    expect(doc.aiMeta.rounds[0].actualWords).toBe(40)
    // 查过了、没有违规：六个分类全 0，而不是 undefined
    expect(doc.aiMeta.rounds[0].counts).toEqual({
      abbreviation: 0,
      proper_noun: 0,
      wordform: 0,
      missing_common: 0,
      rare: 0,
      unknown_token: 0,
    })
  })

  it('成功样本带生成快照：词表版本 / 代码版本 / 模型名', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    // 词表版本是 8 位短 hash；代码版本读不到时是 'unknown'，但不能是空串
    expect(doc.aiMeta.basicWordsVersion).toMatch(/^[0-9a-f]{8}$/)
    expect(typeof doc.aiMeta.codeVersion).toBe('string')
    expect(doc.aiMeta.codeVersion).not.toBe('')
    expect(doc.aiMeta.model).toBe(config.deepseekModel)
  })

  it('失败样本记同一套快照，两类数据才能同框对比', async () => {
    await seedWords(45)

    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(422)

    const [failure] = await GenerationFailure.find().lean()
    expect(failure.basicWordsVersion).toMatch(/^[0-9a-f]{8}$/)
    expect(failure.codeVersion).not.toBe('')
    expect(failure.model).toBe(config.deepseekModel)
  })

  it('第一轮超长触发重写 → 重写轮记下 repairFor=word_count', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: Array.from({ length: 4 }, () => ARTICLE).join(' ') })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.rounds[0].feedbackType).toBe('word_count')
    // 篇幅超长时 evaluate() 直接返回，没跑词汇校验——空数组表示「没查」，不是「没问题」
    expect(doc.aiMeta.rounds[0].unknownWords).toEqual([])
    // counts 同理：没查就是 undefined，不能是六个 0，否则统计里会多出一批"干净"的轮次
    expect(doc.aiMeta.rounds[0].counts).toBeUndefined()
    // 重写后只有 40 词 → 判 short（word_expand），但默认不补写，所以仍停在第二轮
    expect(doc.aiMeta.rounds[1]).toMatchObject({
      kind: 'repair',
      repairFor: 'word_count',
      feedbackType: 'word_expand',
    })
    expect(doc.aiMeta.rounds[1].counts).toMatchObject({ unknown_token: 0, missing_common: 0 })
  })

  it('篇幅额度用尽后仍超长：补查用词，照常放行但生词必须记下来', async () => {
    await seedWords(400)
    // 两次都超长且带 6 个生词：首轮触发重写，重写后额度耗尽 → 210 词版本被放行
    chatJson.mockResolvedValue(
      reply(makePayload({ article: `${LONG_ARTICLE} ${OVER_LIMIT_ARTICLE}` })),
    )

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    // 篇幅额度只有 1 轮：生成 + 重写一次，第二次仍超长就停
    expect(chatJson).toHaveBeenCalledTimes(2)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.actualWords).toBeGreaterThan(115)
    // §6.8：修复前这里恒为空——最「干净」的文章恰恰是没查过的
    expect(doc.newWords).toHaveLength(6)
    expect(doc.aiMeta.violationsCount).toBe(6)

    const last = doc.aiMeta.rounds.at(-1)
    expect(last.feedbackType).toBe('word_count')
    expect(last.unknownWords).toHaveLength(6)
    // 补查过的轮次必须写 counts，否则统计里这批文章还是「没查」
    expect(Object.values(last.counts).reduce((sum, count) => sum + count, 0)).toBe(6)
    // 首轮同样超长、同样被丢弃，但它没有被补查，仍然保持 undefined
    expect(doc.aiMeta.rounds[0].counts).toBeUndefined()
  })
})
