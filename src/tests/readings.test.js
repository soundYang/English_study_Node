import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 上游一律打桩。
 * S6 的目的是验证「我们这一侧」的结构校验、修正轮、落库与 DTO 白名单，
 * 真实 DeepSeek 调用留到 .env 里填好 key 之后手工验一次。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/**
 * 正文只用基础词表里有的词（+ 声明的人名 Tom），
 * 否则词汇校验会把每个用例都拦在 422，测不到真正的分支。
 */
const ARTICLE =
  'Tom is a good boy. His dog is big and the boy is small. Tom and his dog play in the house. The dog runs and the boy runs too. They are good friends. Tom likes his dog very much.'

/** 造一份合法的 AI 输出 */
function makePayload({ questionCount = 3, title = 'A Good Day', article = ARTICLE } = {}) {
  return {
    title,
    article,
    translation:
      '汤姆是个好男孩。他喜欢和他的狗在公园里玩。狗跑得快，汤姆也跑得快。他们一整天都很开心。开心的一天。',
    names: ['Tom'],
    questions: Array.from({ length: questionCount }, (_, index) => ({
      id: index + 1,
      question: `Question number ${index + 1} about the story?`,
      options: ['Tom', 'A dog', 'A park', 'A day'].map(
        (option) => `${option} ${index + 1}`,
      ),
      correctAnswer: index % 4,
      explanation: '根据文章内容可知。',
    })),
  }
}

const reply = (payload) => ({ content: JSON.stringify(payload), usage: { prompt_tokens: 100, completion_tokens: 200 } })

function seedWords(count, status = 'learning') {
  return Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status,
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )
}

const generate = (body) =>
  request(app).post('/api/readings/generate').send(body)

const VALID_BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

beforeEach(() => {
  chatJson.mockReset()
})

describe('POST /api/readings/generate · 参数校验', () => {
  it('词汇量为 0 也先报参数错，不先报词汇不足', async () => {
    const res = await generate({ level: 'insane', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.field).toBe('level')
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('targetWords 不是 10 的倍数 → 400', async () => {
    const res = await generate({ level: 'easy', targetWords: 55, questionCount: 3 })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('targetWords')
  })

  it('questionCount 只能是 3 / 5 / 8 → 400', async () => {
    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 4 })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('questionCount')
  })

  it('字符串形式的 targetWords 不被隐式转换 → 400', async () => {
    const res = await generate({ level: 'easy', targetWords: '100', questionCount: 3 })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('targetWords')
  })
})

describe('POST /api/readings/generate · 词汇量闸门', () => {
  it('不足 20 个 → 422 INSUFFICIENT_VOCABULARY，且不调 AI', async () => {
    await seedWords(19)

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INSUFFICIENT_VOCABULARY')
    expect(res.body.error.message).toContain('19')
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('status=new 的单词不计入可用词汇', async () => {
    await seedWords(19)
    await Word.insertMany(
      Array.from({ length: 5 }, (_, index) => ({
        userId: config.defaultUserId,
        word: `newword${index}`,
        status: 'new',
        source: 'manual',
        senses: [{ pos: '', meaning: '测试释义' }],
      })),
    )

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    expect(chatJson).not.toHaveBeenCalled()
  })
})

describe('POST /api/readings/generate · 正常生成', () => {
  it('返回 201，且 DTO 恰好 9 个字段', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(Object.keys(res.body).sort()).toEqual([
      'article',
      'createdAt',
      'id',
      'level',
      'questionCount',
      'questions',
      'status',
      'targetWords',
      'title',
    ])
    expect(res.body.status).toBe('generated')
    expect(res.body.level).toBe('easy')
    expect(res.body.targetWords).toBe(100)
    expect(res.body.questionCount).toBe(3)
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false)
  })

  it('题目只暴露 id / question / options', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.body.questions).toHaveLength(3)
    expect(Object.keys(res.body.questions[0]).sort()).toEqual(['id', 'options', 'question'])
    expect(res.body.questions[0].options).toHaveLength(4)
  })

  it('响应文本里不出现任何敏感字段名', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    for (const forbidden of [
      'correctAnswer',
      'translation',
      'explanation',
      'userAnswers',
      'aiMeta',
      'correctCount',
      'score',
      'vocabularySnapshot',
      'names',
      'promptTokens',
    ]) {
      expect(res.text).not.toContain(forbidden)
    }
  })

  it('落库内容完整，只把安全字段回给前端', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.translation).toContain('汤姆')
    expect(doc.questions[0].correctAnswer).toBe(0)
    expect(doc.questions[0].explanation).toBe('根据文章内容可知。')
    expect(doc.names).toEqual(['Tom'])
    expect(doc.status).toBe('generated')
    expect(doc.vocabularySnapshot).toHaveLength(20)
    // 测试文章正好 40 个英文词
    expect(doc.actualWords).toBe(40)
    expect(doc.aiMeta).toMatchObject({
      model: config.deepseekModel,
      promptTokens: 100,
      completionTokens: 200,
      repairRounds: 0,
    })
  })

  it('vocabularySnapshot 只收 learning / mastered，不含 new', async () => {
    await seedWords(20)
    await Word.insertMany(
      Array.from({ length: 5 }, (_, index) => ({
        userId: config.defaultUserId,
        word: `newword${index}`,
        status: 'new',
        source: 'manual',
        senses: [{ pos: '', meaning: '测试释义' }],
      })),
    )
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.vocabularySnapshot).toHaveLength(20)
    expect(doc.vocabularySnapshot.some((word) => word.startsWith('newword'))).toBe(false)
  })
})

describe('POST /api/readings/generate · 结构校验与修正轮', () => {
  it('模型自报词汇不足 → 422，不进入修正轮', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(reply({ error: 'INSUFFICIENT_VOCABULARY' }))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INSUFFICIENT_VOCABULARY')
    expect(chatJson).toHaveBeenCalledTimes(1)
  })

  it('首轮不是合法 JSON → 修正一轮成功 → 201 且 repairRounds=1', async () => {
    await seedWords(20)
    chatJson
      .mockResolvedValueOnce({ content: '当然可以！这是文章：' })
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(1)
  })

  it('题目数量不符 → 修正一轮补齐 → 201', async () => {
    await seedWords(20)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ questionCount: 2 })))
      .mockResolvedValueOnce(reply(makePayload({ questionCount: 3 })))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(res.body.questions).toHaveLength(3)
  })

  it('修正轮仍然不合法 → 502 AI_INVALID_RESPONSE，只调两次', async () => {
    await seedWords(20)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ questionCount: 2 })))
      .mockResolvedValueOnce(reply(makePayload({ questionCount: 2 })))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE')
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(await Reading.countDocuments()).toBe(0)
  })

  it('两轮都不是合法 JSON → 502 AI_INVALID_RESPONSE', async () => {
    await seedWords(20)
    chatJson
      .mockResolvedValueOnce({ content: 'not json' })
      .mockResolvedValueOnce({ content: 'still not json' })

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE')
    expect(chatJson).toHaveBeenCalledTimes(2)
  })

  it('模型带了 ```json 代码块标记也能解析', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue({
      content: '```json\n' + JSON.stringify(makePayload()) + '\n```',
      usage: null,
    })

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/readings/generate · 词汇校验', () => {
  it('正文出现表外词 → 修正一轮后合规 → 201 且 repairRounds=1', async () => {
    await seedWords(20)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: `${ARTICLE} Quizzical.` })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(1)
  })

  it('修正后仍含表外词 → 422 VOCABULARY_VALIDATION_FAILED，不留脏数据', async () => {
    await seedWords(20)
    const dirty = reply(makePayload({ article: `${ARTICLE} Quizzical.` }))
    chatJson.mockResolvedValue(dirty)

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_VALIDATION_FAILED')
    expect(res.body.error.message).toContain('quizzical')
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(await Reading.countDocuments()).toBe(0)
  })

  it('违规词再多，错误信息也只列前 5 个', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(
      reply(
        makePayload({
          article: `${ARTICLE} Quizzical zephyrish brontide crepuscule farrago.`,
        }),
      ),
    )

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    const listed = res.body.error.message.split('：')[1]
    expect(listed.split('、')).toHaveLength(5)
  })

  it('一个人名声明之外的大写词也按普通词校验', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(
      reply(makePayload({ article: `${ARTICLE} Lina.` })),
    )

    const res = await generate(VALID_BODY)

    // Lina 没有出现在 names 里，不能被句首/大写规则放行
    expect(res.status).toBe(422)
    expect(res.body.error.message).toContain('lina')
  })
})

describe('POST /api/readings/generate · 上游异常', () => {
  it('上游报错 → 502 AI_PROVIDER_ERROR，不透传原始报错', async () => {
    await seedWords(20)
    const { ApiError, ERROR_CODES } = await import('../shared/errors.js')
    chatJson.mockRejectedValue(
      new ApiError(502, ERROR_CODES.AI_PROVIDER_ERROR, 'AI 服务暂时不可用，请稍后重试。'),
    )

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_PROVIDER_ERROR')
    expect(res.text).not.toContain('sk-')
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect(await Reading.countDocuments()).toBe(0)
  })
})

describe('POST /api/readings/generate · 词汇快照上限', () => {
  it('用户词超过 800 时截断到 800，且全部并入提示词', async () => {
    await seedWords(820)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)

    // 800 个用户词 + 2578 个基础词 + 19 个日历词（may 与基础词表重复，去重后是 18 个）
    const prompt = chatJson.mock.calls[0][0].messages[1].content
    expect(prompt).toContain(`共 ${800 + 2578 + 18} 个`)

    const doc = await Reading.findById(res.body.id)
    expect(doc.vocabularySnapshot).toHaveLength(800)
  })
})
