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
const { basicWordsByLevel } = await import('../modules/readings/basic-words.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/**
 * 正文只用基础词表里有的词（+ 声明的人名 Tom），
 * 否则词汇校验会把每个用例都拦在 422，测不到真正的分支。
 * 词数固定 40，落库断言依赖它。
 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

/** 6 个必然不在词表里的词：超过 maxUnknownWords(5)，才会进入修正轮 */
const OVER_LIMIT_ARTICLE = `${ARTICLE} Quizzical Zephyrish Brontide Crepuscule Farrago Panopticon.`

/** 4 遍基础正文 = 160 词，超过 100 词请求的上限 115 */
const LONG_ARTICLE = Array.from({ length: 4 }, () => ARTICLE).join(' ')

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
      // W7：type / evidence 必填，且 evidence 必须是正文里真实存在的句子。
      // 正确答案统一取 Tom，避免顺带触发 detail 重合度警告（那只是警告，不影响 201）
      type: 'detail',
      evidence: 'Tom is a good boy.',
      options: ['Tom', 'book', 'house', 'friends'],
      correctAnswer: 0,
      explanation: '根据文章内容可知。',
    })),
  }
}

const reply = (payload) => ({ content: JSON.stringify(payload), usage: { prompt_tokens: 100, completion_tokens: 200 } })

/**
 * 400 是 md/20 §2.2 给 easy 定的个人词库下限：400 ∪ 600 基础词 ∪ 日历词 ≥ 1000。
 * 填的词是 word0…word399，与基础词表不相交；日历词再补 18 个，门槛之上留了余量。
 */
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

/**
 * easy 的生词预算是 0（md/20 §3）：一个生词就会触发修正轮。
 * 「预算内放行」这条规则只有 medium(3) / hard(5) 才观察得到，
 * 所以放行类用例走 medium；easy + 1 个生词单独有一条用例守着。
 * medium 的已知词门是 1900；基础词三档统一 600 之后，个人词库至少要 1282 个，
 * 这些用例统一填 1300 个留一点余量。
 */
const MEDIUM_BODY = { level: 'medium', targetWords: 100, questionCount: 3 }

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
  // 100 / 200 词走冷启动，0 词也能生成（md/39）；这道闸门只在 300 词以上生效
  const LONG_BODY = { ...VALID_BODY, targetWords: 300 }

  it('不足 20 个 → 422 INSUFFICIENT_VOCABULARY，且不调 AI', async () => {
    await seedWords(19)

    const res = await generate(LONG_BODY)

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

    const res = await generate(LONG_BODY)

    expect(res.status).toBe(422)
    expect(chatJson).not.toHaveBeenCalled()
  })
})

describe('POST /api/readings/generate · 正常生成', () => {
  it('返回 201，且 DTO 恰好 14 个字段', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(Object.keys(res.body).sort()).toEqual([
      'actualWords',
      'article',
      'createdAt',
      'focusWords',
      'id',
      'level',
      'newWords',
      'questionCount',
      'questions',
      'status',
      'targetWords',
      'title',
      'tokenUsage',
      // md/56 §6.3：本篇实际用到的用户词
      'usedWords',
    ])
    expect(res.body.status).toBe('generated')
    expect(res.body.level).toBe('easy')
    expect(res.body.targetWords).toBe(100)
    expect(res.body.questionCount).toBe(3)
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false)
  })

  it('题目只暴露 id / question / type / options', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.body.questions).toHaveLength(3)
    // type 给答题页做题型标签；evidence 是答案所在的句子，不能在这里出现
    expect(Object.keys(res.body.questions[0]).sort()).toEqual([
      'id',
      'options',
      'question',
      'type',
    ])
    expect(res.body.questions[0].type).toBe('detail')
    expect(res.body.questions[0].options).toHaveLength(4)
  })

  it('响应文本里不出现任何敏感字段名', async () => {
    await seedWords(400)
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
    ]) {
      expect(res.text).not.toContain(forbidden)
    }

    // tokenUsage 是**故意**回给用户的，和 aiMeta 不是一回事：
    // 只允许这三个字段，其他 aiMeta 内容一个都不能漏
    expect(Object.keys(res.body.tokenUsage).sort()).toEqual([
      'completionTokens',
      'promptTokens',
      'totalTokens',
    ])
  })

  it('落库内容完整，只把安全字段回给前端', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.translation).toContain('汤姆')
    expect(doc.questions[0].correctAnswer).toBe(0)
    expect(doc.questions[0].explanation).toBe('根据文章内容可知。')
    expect(doc.names).toEqual(['Tom'])
    expect(doc.status).toBe('generated')
    // easy + 100 词：目标词 10 个；池子按比例取 max(10, ceil(400 × 0.35)) = 140
    expect(doc.vocabularySnapshot).toHaveLength(140)
    // 测试文章正好 40 个英文词
    expect(doc.actualWords).toBe(40)
    // W7：题目的 type / evidence 与难度分数都要落库
    expect(doc.questions[0].type).toBe('detail')
    expect(doc.questions[0].evidence).toBe('Tom is a good boy.')
    expect(doc.aiMeta.difficulty.score).toEqual(expect.any(Number))
    expect(doc.aiMeta.difficulty.metrics.avgSentenceLength).toBeGreaterThan(0)
    // 题目没问题也要落一个空数组：undefined 在老文档里表示「当时没检查」
    expect(doc.aiMeta.questionWarnings).toEqual([])
    expect(doc.aiMeta).toMatchObject({
      model: config.deepseekModel,
      promptTokens: 100,
      completionTokens: 200,
      repairRounds: 0,
    })
  })

  it('detail 答案与依据重合不足时仍然 201，警告落进 aiMeta', async () => {
    await seedWords(400)
    const payload = makePayload()
    // 正确选项与 evidence「Tom is a good boy.」零实词重合：
    // 旧实现会在这判 502，现在只记一条警告（md/30 §10-7）
    payload.questions[0].options = ['A blue car', 'book', 'house', 'friends']
    chatJson.mockResolvedValue(reply(payload))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(1)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.status).toBe('generated')
    expect(doc.aiMeta.repairRounds).toBe(0)
    expect(doc.aiMeta.questionWarnings).toEqual([
      expect.objectContaining({ questionId: 1, code: 'detail_answer_overlap' }),
    ])
  })

  it('vocabularySnapshot 只收 learning / mastered，不含 new', async () => {
    await seedWords(400)
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
    // easy + 100 词：池子按比例取 max(10, ceil(400 × 0.35)) = 140
    expect(doc.vocabularySnapshot).toHaveLength(140)
    expect(doc.vocabularySnapshot.some((word) => word.startsWith('newword'))).toBe(false)
  })
})

describe('POST /api/readings/generate · 结构校验与修正轮', () => {
  it('模型自报词汇不足 → 422，不进入修正轮', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply({ error: 'INSUFFICIENT_VOCABULARY' }))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INSUFFICIENT_VOCABULARY')
    expect(chatJson).toHaveBeenCalledTimes(1)
  })

  it('首轮不是合法 JSON → 修正一轮成功 → 201 且 repairRounds=1', async () => {
    await seedWords(400)
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
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ questionCount: 2 })))
      .mockResolvedValueOnce(reply(makePayload({ questionCount: 3 })))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(res.body.questions).toHaveLength(3)
  })

  it('题目编造 evidence → 只重写题目，正文保留（W7）', async () => {
    await seedWords(400)
    const fabricated = makePayload()
    fabricated.questions[1] = { ...fabricated.questions[1], evidence: 'Tom has a blue car.' }

    chatJson
      .mockResolvedValueOnce(reply(fabricated))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)
    // 正文没问题，不该再整篇重写一遍
    expect(chatJson.mock.calls[1][0].messages.at(-1).content).toContain('只重写 questions')

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.rounds[0].feedbackType).toBe('questions')
    expect(doc.aiMeta.rounds[1].repairFor).toBe('questions')
  })

  it('题型配额不满足（easy 全是推断题）→ 同样只重写题目', async () => {
    await seedWords(400)
    const wrongQuota = makePayload()
    wrongQuota.questions = wrongQuota.questions.map((question) => ({
      ...question,
      type: 'inference',
    }))

    chatJson
      .mockResolvedValueOnce(reply(wrongQuota))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.rounds[0].feedbackType).toBe('questions')
  })

  it('两轮修正后仍不合法 → 502 AI_INVALID_RESPONSE，最多调三次', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload({ questionCount: 2 })))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE')
    // 首次 + 两轮修正
    expect(chatJson).toHaveBeenCalledTimes(3)
    expect(await Reading.countDocuments()).toBe(0)
  })

  it('三轮都不是合法 JSON → 502 AI_INVALID_RESPONSE', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue({ content: 'not json' })

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE')
    expect(chatJson).toHaveBeenCalledTimes(3)
  })

  it('结构不合法时，修正请求不带上一轮的残缺输出', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue({ content: 'not json' })

    await generate(VALID_BODY)

    // 把半截内容当 assistant 消息喂回去会诱导模型照抄
    const repairMessages = chatJson.mock.calls[1][0].messages
    expect(repairMessages.some((item) => item.role === 'assistant')).toBe(false)
  })

  it('模型带了 ```json 代码块标记也能解析', async () => {
    await seedWords(400)
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
  it('打开 allowNewWords 后，表外词不超过预算直接放行（medium 预算 3）', async () => {
    await seedWords(1300)
    chatJson.mockResolvedValue(reply(makePayload({ article: `${ARTICLE} Quizzical.` })))

    const res = await generate({ ...MEDIUM_BODY, allowNewWords: true })

    expect(res.status).toBe(201)
    // 预算是承诺不是配额：预算内的生词不值得再花一轮调用
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect(res.body.newWords).toHaveLength(1)
    expect(res.body.newWords[0].word).toBe('quizzical')

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(0)
    expect(doc.aiMeta.violationsCount).toBe(1)
  })

  it('easy 的预算是 0：一个生词也要修一轮（承诺「一个生词都没有」）', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: `${ARTICLE} Quizzical.` })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(res.body.newWords).toEqual([])

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(1)
    expect(doc.aiMeta.rounds[0].feedbackType).toBe('vocabulary')
  })

  it('放行的生词带词典音标与释义', async () => {
    await seedWords(1300)
    // loud 的 rank 是 3120，在 §4.2 扩表后的放行范围之外，才测得到「生词」分支
    chatJson.mockResolvedValue(reply(makePayload({ article: `${ARTICLE} Loud.` })))

    const res = await generate({ ...MEDIUM_BODY, allowNewWords: true })

    expect(res.status).toBe(201)
    expect(res.body.newWords[0]).toMatchObject({ word: 'loud', source: 'dictionary' })
    expect(res.body.newWords[0].phonetic.us).toBeTruthy()
    expect(res.body.newWords[0].senses[0].meaning).toBeTruthy()
  })

  it('超过额度 → 修正一轮后合规 → 201 且 repairRounds=1', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)
    expect(res.body.newWords).toEqual([])

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(1)
  })

  it('第 1 轮仍超额、第 2 轮修好 → 201 且 repairRounds=2', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE })))
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(3)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(2)
  })

  it('结构合法的修正轮会带上模型自己的上一轮输出', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE })))
      .mockResolvedValueOnce(reply(makePayload()))

    await generate(VALID_BODY)

    const repairMessages = chatJson.mock.calls[1][0].messages
    const assistant = repairMessages.find((item) => item.role === 'assistant')
    expect(assistant.content).toContain('Quizzical')
  })

  it('两轮修正后仍超额 → 422 VOCABULARY_VALIDATION_FAILED，不留脏数据', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload({ article: OVER_LIMIT_ARTICLE })))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_VALIDATION_FAILED')
    expect(res.body.error.message).toContain('quizzical')
    expect(chatJson).toHaveBeenCalledTimes(3)
    expect(await Reading.countDocuments()).toBe(0)
  })

  it('违规词再多，错误信息也只列前 5 个', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(
      reply(
        makePayload({
          article: `${ARTICLE} Quizzical zephyrish brontide crepuscule farrago panopticon umbratile kernelly.`,
        }),
      ),
    )

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(422)
    const listed = res.body.error.message.split('：')[1]
    expect(listed.split('、')).toHaveLength(5)
  })

  it('大写词不在 names 里时，仍按普通词处理并标注为未学', async () => {
    await seedWords(1300)
    chatJson.mockResolvedValue(reply(makePayload({ article: `${ARTICLE} Lina.` })))

    const res = await generate({ ...MEDIUM_BODY, allowNewWords: true })

    // 不能被句首/大写规则悄悄放行：它进了 newWords，说明确实按普通词校验过
    expect(res.status).toBe(201)
    expect(res.body.newWords).toHaveLength(1)
    expect(res.body.newWords[0].word).toBe('lina')
  })
})

describe('POST /api/readings/generate · 篇幅与 token', () => {
  it('安全 DTO 带回真实词数', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.body.actualWords).toBe(40)
  })

  it('正文偏短时默认不追加调用，只把 lengthStatus 记为 short', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload())) // 40 词，100 词请求的验收下限是 85

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    // MAX_EXPAND_ROUNDS 默认 0：短文章照旧放行，不花一次调用去补
    expect(chatJson).toHaveBeenCalledTimes(1)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.lengthStatus).toBe('short')
    expect(doc.aiMeta.repairRounds).toBe(0)
  })

  it('超过上限时追加一轮重写，指令给句子预算且不带上一篇', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: LONG_ARTICLE })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(2)

    const messages = chatJson.mock.calls[1][0].messages
    const instruction = messages.at(-1).content
    // 100 词请求 + easy（每句 12 词）→ 约 9 句；每句词数由目标值 110 反推
    expect(instruction).toContain('共 8–10 个英文句子')
    expect(instruction).toContain('每句 12 个英文单词')
    expect(instruction).toContain('必须落在 100–110 词之间')
    // 带锚定只会让模型做减法，所以重写轮不塞上一篇正文
    expect(messages.some((message) => message.role === 'assistant')).toBe(false)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(1)
    // 重写后的正文落库，不再是被截断的 160 词版本
    expect(doc.actualWords).toBe(40)
    expect(doc.aiMeta.rounds[0].actualWords).toBe(160)
  })

  it('又超长又有生词时先重写篇幅，而不是先修用词', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: `${LONG_ARTICLE} ${OVER_LIMIT_ARTICLE}` })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    // 用词修正实测会把文章改得更长，所以篇幅优先
    const instruction = chatJson.mock.calls[1][0].messages.at(-1).content
    expect(instruction).toContain('重新写一篇文章')
    expect(instruction).not.toContain('不在允许词表中')
    expect(res.status).toBe(201)
  })

  it('篇幅重写有独立额度：修完词还能再重写一次', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE }))) // 1: 生词超额度
      .mockResolvedValueOnce(reply(makePayload({ article: LONG_ARTICLE }))) // 2: 词好了但太长
      .mockResolvedValueOnce(reply(makePayload())) // 3: 压缩后达标

    const res = await generate(VALID_BODY)

    // 旧实现里三者共用 2 轮额度，第 3 次调用会被砍掉，直接带着 160 词返回
    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(3)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(2)
    expect(doc.aiMeta.rounds.map((round) => round.kind)).toEqual([
      'generate',
      'repair',
      'repair',
    ])
    expect(doc.actualWords).toBe(40)
  })

  it('重写后仍超生词额度时，多给一轮用词修正', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE }))) // 1: 生词超额度
      .mockResolvedValueOnce(reply(makePayload({ article: LONG_ARTICLE }))) // 2: 太长 → 重写
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE }))) // 3: 重写带出 6 个生词
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE }))) // 4: 修词后仍超
      .mockResolvedValueOnce(reply(makePayload())) // 5: 第三次用词修正救回来

    const res = await generate(VALID_BODY)

    // 没有这条规则时，第 4 次调用不存在，第 3 轮的 6 个生词会直接 422
    expect(res.status).toBe(201)
    expect(chatJson).toHaveBeenCalledTimes(5)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.repairRounds).toBe(4)
  })

  it('多轮调用的 token 是累加，不是只留最后一轮', async () => {
    await seedWords(400)
    chatJson
      .mockResolvedValueOnce(reply(makePayload({ article: OVER_LIMIT_ARTICLE })))
      .mockResolvedValueOnce(reply(makePayload()))

    const res = await generate(VALID_BODY)

    // 每次打桩 usage 都是 prompt 100 / completion 200
    expect(res.body.tokenUsage).toEqual({
      promptTokens: 200,
      completionTokens: 400,
      totalTokens: 600,
    })

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.rounds.map((round) => round.kind)).toEqual(['generate', 'repair'])
    expect(doc.aiMeta.rounds[0]).toMatchObject({
      promptTokens: 100,
      completionTokens: 200,
      maxTokens: 8192,
      // 每轮记下真实词数：调篇幅策略时能看到每一轮是变长还是变短
      actualWords: 46,
    })
    expect(doc.aiMeta.rounds[1].actualWords).toBe(40)
  })

  it('上限固定 8192，不再按篇幅估算', async () => {
    await seedWords(400)
    chatJson.mockResolvedValue(reply(makePayload()))

    await generate(VALID_BODY)

    expect(chatJson.mock.calls[0][0].maxTokens).toBe(8192)
  })
})

describe('POST /api/readings/generate · 上游异常', () => {
  it('上游报错 → 502 AI_PROVIDER_ERROR，不透传原始报错', async () => {
    await seedWords(400)
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

describe('POST /api/readings/generate · 候选池截断', () => {
  it('按难度比例选池，不再按 createdAt 截断', async () => {
    await seedWords(820)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate(VALID_BODY)

    expect(res.status).toBe(201)

    // easy 取 35%：ceil(820 × 0.35) = 287 个候选词。
    // 词表分三段渲染：目标词 10（其中重点词 4）+ 补充可用词 277 + easy 档基础词 600
    const prompt = chatJson.mock.calls[0][0].messages[1].content
    expect(prompt).toContain('【目标词】共 10 个')
    expect(prompt).toContain('【补充可用词】共 277 个')
    expect(prompt).toContain(`【基础词】共 ${basicWordsByLevel.easy.length} 个`)
    expect(prompt).toContain('★ ')

    const doc = await Reading.findById(res.body.id)
    expect(doc.vocabularySnapshot).toHaveLength(287)
    expect(doc.targetPlan.poolSize).toBe(287)
    expect(doc.targetPlan.requiredWords).toBe(10)
    expect(doc.targetPlan.focusWords).toHaveLength(4)
    expect(doc.targetPlan.scope).toEqual(['all'])
  })
})
