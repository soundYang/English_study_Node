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
const { basicWordsByLevel } = await import('../modules/readings/basic-words.js')
const { calendarWords } = await import('../modules/readings/calendar-words.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/**
 * 基础词（三档统一 easy 600）∪ 日历词的并集大小 = 618（may 等 1 个词两边都有）。
 *
 * 2026-10-28 起基础词表不再按难度变化，所以 knownWords 只有这一个地板。
 * 原来每个档位各写一个数字（1018 / 1758 / 2996），现在三档同为 personal + 618。
 */
const BASE_UNION = new Set([...basicWordsByLevel.easy, ...calendarWords]).size

/** 只用基础 600 词 + 声明的人名，保证过得了词汇校验 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const payload = {
  title: 'A Good Day',
  article: ARTICLE,
  translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
  names: ['Tom'],
  // W7：同一份 payload 要同时满足 easy（≥2 detail）与 hard（≥1 inference），
  // 所以固定 2 道细节题 + 1 道推断题；evidence 取自正文
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
      kind: 'target_words',
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

  it('A 门只看本次 scope：缩短篇幅（或缩小词源）就能过', async () => {
    // 已知词门看全库，与 scope 无关。基础词统一 600 后 hard 要 3778，
    // 个人词库得攒到 3160 个才跨得过去
    await seedWords(3200, 'old')
    await Word.collection.updateMany(
      { userId: config.defaultUserId },
      { $set: { createdAt: new Date('2020-01-01T00:00:00Z') } },
    )
    await seedWords(45, 'fresh')
    chatJson.mockResolvedValue(reply)

    // hard + 600：目标词 60 个，门槛 ceil(60 ÷ 0.7) = 86 个，45 个 fresh 不够
    const long = await generate({
      level: 'hard',
      targetWords: 600,
      questionCount: 3,
      vocabScope: ['today_new'],
    })

    expect(long.status).toBe(422)
    expect(long.body.error.details.kind).toBe('target_words')

    // hard + 100：目标词 10 个，门槛 ceil(10 ÷ 0.7) = 15 个，45 个够用
    const short = await generate({
      level: 'hard',
      targetWords: 100,
      questionCount: 3,
      vocabScope: ['today_new'],
    })

    expect(short.status).toBe(201)
  })

  it('已知词汇量不够时，缩短篇幅也救不了——只能加词或降难度', async () => {
    await seedWords(45)
    chatJson.mockResolvedValue(reply)

    // hard / 100：A 门（15 个）过了，B 门（3778）过不了
    const res = await generate({ level: 'hard', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    expect(res.body.error.details).toMatchObject({
      kind: 'known_words',
      level: 'hard',
      required: 3778,
      // 45 个个人词 ∪ 基础 600 ∪ 日历（去重后）——并集去重后的真实数字
      available: 45 + BASE_UNION,
    })
    expect(res.body.error.message).toContain('还差')
    expect(chatJson).not.toHaveBeenCalled()
  })
})

describe('候选池与目标词计划', () => {
  it('1282 个词 + medium + 300 → 池子取 50% 得 641 个', async () => {
    // 基础词统一 600 后 medium 的 B 门要 1900，个人词库至少 1282 个
    await seedWords(1282)
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'medium', targetWords: 300, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    // ceil(1282 × 0.5) = 641，没到 POOL_LIMIT 800
    expect(doc.vocabularySnapshot).toHaveLength(641)
    expect(doc.targetPlan.poolSize).toBe(641)
    expect(doc.targetPlan.requiredWords).toBe(30)
    expect(doc.targetPlan.focusWords).toHaveLength(11)
    expect(doc.targetPlan.scope).toEqual(['all'])
    expect(doc.aiMeta.candidatePoolSize).toBe(641)
    expect(doc.aiMeta.requiredWords).toBe(30)
  })

  it('候选池只会更小，不会因为词库大就按 createdAt 截断', async () => {
    // hard 的已知词门是 3778，3160 个人词才跨得过去；70% = 2212 → 封顶 800
    // （POOL_LIMIT，与 targetWords 上限无关）。这也意味着 hard 场景下 800 总是生效。
    await seedWords(3200)
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.targetPlan.poolSize).toBe(800)
  })
})

describe('校验词表与提示词词表分离', () => {
  it('池外但用户学过的词不算表外', async () => {
    await seedWords(400)
    // cocaRank 极大 → easy 按排名升序取前 141 个，这个词必然落在池外
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
    await seedWords(400)
    // 6 个 > easy 预算 0：进入修正轮，两轮后仍超额 → 422
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

  it('三档门禁一次全回：目标词门 / 已知词门 / 生词预算 / 篇幅上限', async () => {
    await seedWords(400)

    const res = await capacity({ targetWords: 200 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      targetWords: 200,
      available: 400,
      wordRange: { min: 200, target: 220, max: 230, label: '200–230 词' },
      acceptedRange: { min: 170, target: 220, max: 230, label: '170–230 词' },
      levels: {
        easy: {
          required: 58,
          sufficient: true,
          shortage: 0,
          // 400 个人词 ∪ 基础 600 ∪ 日历（去重后）= 1018 ≥ 1000
          knownWords: 400 + BASE_UNION,
          requiredKnown: 1000,
          knownSufficient: true,
          knownShortage: 0,
          unknownBudget: 0,
          maxTargetWords: 300,
          targetWordsAllowed: true,
        },
        medium: {
          required: 40,
          sufficient: true,
          // 基础词统一 600 后 medium 也只剩 1018 < 1900：词量够写，但这个难度还没解锁
          knownWords: 400 + BASE_UNION,
          requiredKnown: 1900,
          knownSufficient: false,
          knownShortage: 1900 - (400 + BASE_UNION),
          unknownBudget: 3,
          maxTargetWords: 450,
        },
        hard: {
          required: 29,
          sufficient: true,
          knownWords: 400 + BASE_UNION,
          requiredKnown: 3778,
          knownSufficient: false,
          knownShortage: 3778 - (400 + BASE_UNION),
          unknownBudget: 5,
          maxTargetWords: 600,
        },
      },
    })
  })

  it('词量不够时给出差额，且与真实闸门同数字', async () => {
    await seedWords(45)

    const res = await capacity({ targetWords: 600 })

    expect(res.body.levels.hard).toMatchObject({
      required: 86,
      sufficient: false,
      shortage: 41,
      knownWords: 45 + BASE_UNION,
      knownSufficient: false,
    })

    // 同一组参数真的去生成，422 里回的数字必须一致（A 门先报）
    const rejected = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })
    expect(rejected.status).toBe(422)
    expect(rejected.body.error.details.kind).toBe('target_words')
    expect(rejected.body.error.details.required).toBe(res.body.levels.hard.required)
    expect(rejected.body.error.details.available).toBe(res.body.available)
  })

  it('每档候选池大小各自返回，顶层 available 只是 hard 口径', async () => {
    await seedWords(45)

    const res = await capacity({ targetWords: 600 })

    // English_vue/md/13 B1：设置页在 easy 下不能拿 hard 的池子数字说话
    for (const level of ['easy', 'medium', 'hard']) {
      expect(Number.isInteger(res.body.levels[level].available)).toBe(true)
    }
    // 顶层字段为兼容保留，语义固定为「最后一档」= hard
    expect(res.body.available).toBe(res.body.levels.hard.available)
  })

  it('已知词门：预检的 knownShortage 与生成的 422 文案是同一个数', async () => {
    await seedWords(400)

    const res = await capacity({ targetWords: 100 })
    expect(res.body.levels.medium.knownSufficient).toBe(false)

    const rejected = await generate({ level: 'medium', targetWords: 100, questionCount: 3 })
    expect(rejected.status).toBe(422)
    expect(rejected.body.error.details).toMatchObject({
      kind: 'known_words',
      required: res.body.levels.medium.requiredKnown,
      available: res.body.levels.medium.knownWords,
    })
    expect(rejected.body.error.message).toContain(
      `还差 ${res.body.levels.medium.knownShortage} 个`,
    )
  })

  it('篇幅上限跟难度走：easy 300 词能过，400 词是参数错', async () => {
    await seedWords(400)

    // 500 词：easy(300) / medium(450) 都不允许，只有 hard(600) 可以
    const wide = await capacity({ targetWords: 500 })
    expect(wide.body.levels.easy.targetWordsAllowed).toBe(false)
    expect(wide.body.levels.medium.targetWordsAllowed).toBe(false)
    expect(wide.body.levels.hard.targetWordsAllowed).toBe(true)

    const res = await generate({ level: 'easy', targetWords: 400, questionCount: 3 })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('targetWords')
    expect(res.body.error.message).toContain('简单模式最高支持 300 词')
    expect(chatJson).not.toHaveBeenCalled()
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

describe('700 词库的产品含义（md/20 §2.3）', () => {
  /**
   * 700 个词，其中 300 个本来就在基础词表里（现在三档共用 easy 600）。
   * 真实用户的词库不可能与基础表不相交——把 700 个填充词当成「互不相交」，
   * 会算出 700 + 600 > 1900 的假通过，验收标准就测不到。
   */
  async function seed700() {
    const docs = basicWordsByLevel.easy.slice(0, 300).map((word, index) => ({
      userId: config.defaultUserId,
      word,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: `基础词 ${index}` }],
    }))

    await Word.insertMany([
      ...docs,
      ...Array.from({ length: 400 }, (_, index) => ({
        userId: config.defaultUserId,
        word: `extra${index}`,
        status: 'learning',
        source: 'manual',
        senses: [{ pos: '', meaning: '测试释义' }],
      })),
    ])
  }

  it('easy 300 通过；medium 422 并说清「还差多少个词」', async () => {
    await seed700()
    chatJson.mockResolvedValue(reply)

    // easy：600 基础 + 400 新词 + 日历 18 = 1018 ≥ 1000
    const easy = await generate({ level: 'easy', targetWords: 300, questionCount: 3 })
    expect(easy.status).toBe(201)

    // medium：基础词同样是 600，于是也只剩 1018 < 1900，短线 882
    const medium = await generate({ level: 'medium', targetWords: 300, questionCount: 3 })
    expect(medium.status).toBe(422)
    expect(medium.body.error.details).toMatchObject({
      kind: 'known_words',
      level: 'medium',
      required: 1900,
      available: 400 + BASE_UNION,
      shortage: 1900 - (400 + BASE_UNION),
    })
    expect(medium.body.error.message).toContain('还差 882 个')
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
    await seedWords(400)
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
