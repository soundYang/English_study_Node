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
  it('45 个词 + hard + 600 → 422，门槛是 minKnown(600)=704', async () => {
    await seedWords(45)

    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    expect(res.body.error.field).toBe('targetWords')
    // md/30 §7.2：600 词的实测下限 704（618 基础 ∪ 日历 + 86 个 A 门折算）。
    // 45 个个人词只有 663 个已知词，差 41——门槛随篇幅走，此时先报的是「词不够」
    expect(res.body.error.details).toEqual({
      kind: 'known_words',
      level: 'hard',
      targetWords: 600,
      required: 704,
      available: 45 + BASE_UNION,
      shortage: 704 - (45 + BASE_UNION),
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

  it('已知词门槛随篇幅走：20 个词写不了 300 词，但写得了 100 词', async () => {
    await seedWords(20)
    chatJson.mockResolvedValue(reply)

    // 20 + 618 = 638 个已知词。300 词要 661（实测点），差 23
    const long = await generate({ level: 'hard', targetWords: 300, questionCount: 3 })

    expect(long.status).toBe(422)
    expect(long.body.error.code).toBe('VOCABULARY_TOO_SMALL')
    expect(long.body.error.details).toMatchObject({
      kind: 'known_words',
      level: 'hard',
      targetWords: 300,
      required: 661,
      available: 20 + BASE_UNION,
      shortage: 23,
    })
    expect(chatJson).not.toHaveBeenCalled()

    // 100 词只要 638（实测点），刚好够——这就是「缩篇幅能解」，
    // 与旧 B 门「只能加词或降难度」的结论相反（md/30 §7.2）
    const short = await generate({ level: 'hard', targetWords: 100, questionCount: 3 })

    expect(short.status).toBe(201)
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

  it('三档一次全回：目标词门 / 篇幅门槛 / 生词预算 / 解锁状态 / 篇幅阶梯', async () => {
    await seedWords(400)

    const res = await capacity({ targetWords: 200 })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      targetWords: 200,
      available: 400,
      // 顶层两个汇总字段并排放：personalWords 才是解锁口径
      knownWords: 400 + BASE_UNION,
      personalWords: 400,
      finalMode: { unlocked: false, unlockAt: 3000, shortage: 2600, maxTargetWords: 1000 },
      wordRange: { min: 200, target: 220, max: 220, label: '200–220 词' },
      acceptedRange: { min: 170, target: 220, max: 230, label: '170–230 词' },
      levels: {
        easy: {
          required: 58,
          sufficient: true,
          shortage: 0,
          knownWords: 400 + BASE_UNION,
          personalWords: 400,
          // minKnown(200, easy) = 618 + ceil(20 ÷ 0.35) = 676
          minKnown: 676,
          unknownBudget: 0,
          maxTargetWords: 300,
          targetWordsAllowed: true,
          finalMode: { supported: false, unlocked: false, unlockAt: 3000, shortage: 2600, active: false },
        },
        medium: {
          required: 40,
          sufficient: true,
          knownWords: 400 + BASE_UNION,
          minKnown: 658,
          unknownBudget: 3,
          maxTargetWords: 450,
        },
        hard: {
          required: 29,
          sufficient: true,
          knownWords: 400 + BASE_UNION,
          // minKnown(200, hard) = max(实测 647, 618 + 29) = 647
          minKnown: 647,
          unknownBudget: 5,
          maxTargetWords: 600,
        },
      },
    })
  })

  it('篇幅阶梯按难度给，blockedBy 说明为什么不能写', async () => {
    await seedWords(400)

    const res = await capacity({ targetWords: 200 })
    const { easy, hard } = res.body.levels

    // 阶梯固定 10 行，100–1000 每 100 一档
    expect(easy.lengths).toHaveLength(10)
    expect(easy.lengths.map((row) => row.targetWords)).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ])

    // easy 的 300 能写、400 是档位到头（不是词不够）
    expect(easy.lengths[2]).toMatchObject({ targetWords: 300, unlocked: true, blockedBy: null, shortage: 0 })
    expect(easy.lengths[3]).toMatchObject({ targetWords: 400, unlocked: false, blockedBy: 'level_cap', shortage: 0 })

    // hard 的 600 能写，700+ 要最终模式：差的是个人词库，不是 knownWords
    expect(hard.lengths[5]).toMatchObject({ targetWords: 600, unlocked: true, blockedBy: null })
    expect(hard.lengths[6]).toMatchObject({
      targetWords: 700,
      unlocked: false,
      blockedBy: 'final_mode',
      shortage: 3000 - 400,
      finalMode: true,
    })
  })

  it('词量不够时给出差额，且与真实闸门同数字', async () => {
    await seedWords(45)

    const res = await capacity({ targetWords: 600 })

    expect(res.body.levels.hard).toMatchObject({
      // A 门本身是够的（86 > 45 才不够，这里池子 45 < 86，两门同时不足）
      required: 86,
      sufficient: false,
      shortage: 41,
      knownWords: 45 + BASE_UNION,
      // 45 + 618 = 663 < 704
      minKnown: 704,
    })
    // 阶梯上 600 这一行是「词不够」，不是「档位到头」
    expect(res.body.levels.hard.lengths[5]).toMatchObject({
      targetWords: 600,
      unlocked: false,
      blockedBy: 'known_words',
      shortage: 41,
    })

    // 同一组参数真的去生成，422 里回的数字必须一致（篇幅门槛先报）
    const rejected = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })
    expect(rejected.status).toBe(422)
    expect(rejected.body.error.details.kind).toBe('known_words')
    expect(rejected.body.error.details.required).toBe(res.body.levels.hard.minKnown)
    expect(rejected.body.error.details.available).toBe(res.body.levels.hard.knownWords)
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

  it('篇幅门槛：预检的 minKnown 与生成的 422 是同一个数', async () => {
    await seedWords(20)

    const res = await capacity({ targetWords: 300 })
    expect(res.body.levels.medium.minKnown).toBe(678)
    expect(res.body.levels.medium.knownWords).toBe(20 + BASE_UNION)

    const rejected = await generate({ level: 'medium', targetWords: 300, questionCount: 3 })
    expect(rejected.status).toBe(422)
    expect(rejected.body.error.details).toMatchObject({
      kind: 'known_words',
      required: res.body.levels.medium.minKnown,
      available: res.body.levels.medium.knownWords,
      shortage: 40,
    })
    // 文案里的差额与阶梯上的 shortage 同源
    expect(rejected.body.error.message).toContain('还差 40 个')
    expect(res.body.levels.medium.lengths[2]).toMatchObject({
      targetWords: 300,
      blockedBy: 'known_words',
      shortage: 40,
    })
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

describe('700 词库的产品含义（md/30 §7：B 门删除后的能力边界）', () => {
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

  it('700 个词能把三档写到各自上限——旧 B 门要求 hard 3778，是它的 5.4 倍', async () => {
    await seed700()
    chatJson.mockResolvedValue(reply)

    // knownWords = 600 基础 − 300(重合) + 700 = 1018。
    // 三档各自上限下的 minKnown 最高是 hard 600 的 704，全部够得着
    const caps = { easy: 300, medium: 450, hard: 600 }

    for (const [level, targetWords] of Object.entries(caps)) {
      const res = await generate({ level, targetWords, questionCount: 3 })
      expect(res.status).toBe(201)
      const doc = await Reading.findById(res.body.id).lean()
      expect(doc.aiMeta.knownWords).toBe(BASE_UNION + 400)
      expect(doc.aiMeta.minKnown).toBeLessThanOrEqual(BASE_UNION + 400)
      expect(doc.aiMeta.personalWords).toBe(700)
    }
  })

  it('但最终模式（700 词）要个人词库 3000，700 个词远远不够', async () => {
    await seed700()
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'hard', targetWords: 700, questionCount: 3 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.details).toMatchObject({
      kind: 'final_mode_locked',
      metric: 'personal_words',
      unlockAt: 3000,
      available: 700,
      shortage: 2300,
    })
    // 报的是「去背单词」，不是「缩短篇幅」——用户要做的事不同
    expect(res.body.error.message).toContain('个人词库')
    expect(chatJson).not.toHaveBeenCalled()
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
