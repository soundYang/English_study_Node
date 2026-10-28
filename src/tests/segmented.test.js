import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 句级闭环生成（md/21 W4 / md/20 §5）。
 *
 * 与其它集成测试的区别：这个文件把生成策略改成 segmented。
 * 其它文件在 setup.js 里统一跑 whole 路径（它们测的是整篇修正轮的行为）。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

vi.mock('../config/index.js', async (importOriginal) => {
  const actual = await importOriginal()

  return {
    ...actual,
    config: Object.freeze({ ...actual.config, generationStrategy: 'segmented' }),
  }
})

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { generateReading } = await import('../modules/readings/reading.service.js')
const { GenerationFailure } = await import('../modules/readings/generation-failure.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 只用 easy 基础词，任何一段单独校验都应通过 */
const SHORT =
  'A good boy has a big book. The boy and his book play in the house. They are good friends.'

/** 600 词篇幅下每段约 62 词：丢 1 段后 9 段仍落在验收区间 510–690 */
const LONG =
  `${SHORT} The small boy is very good and his big book is very good too.`
  + ' A good friend with a big book is in the house and likes the small book.'
  + ' The boy and his friend like the book in the house.'

const BAD = 'A good boy has a zzzz book.'

const PLAN = {
  segments: [
    { id: 1, goal: '介绍男孩和他的书', mustUse: [], maxWords: 37 },
    { id: 2, goal: '写他们在房子里玩', mustUse: [], maxWords: 37 },
    { id: 3, goal: '写他们是好朋友', mustUse: [], maxWords: 37 },
  ],
}

const FINISH = {
  title: 'A Good Day',
  translation: '一个男孩有一本很大的书，他和书在房子里玩，他们是好朋友。',
  names: [],
  // W7：第 3 道做成推断题，同一份 FINISH 就能同时满足 easy（≥2 detail）与 hard（≥1 inference）；
  // evidence 取自 SHORT，段落怎么拼都在正文里
  questions: [1, 2, 3].map((id) => ({
    id,
    question: `What is question number ${id} about?`,
    type: id === 3 ? 'inference' : 'detail',
    evidence: 'They are good friends.',
    options: ['good friends', 'A boy', 'A book', 'A house'],
    correctAnswer: 0,
    explanation: '根据正文可知。',
  })),
}

/** 第 2 题是 detail，但正确答案（big / book）与 evidence（good / friends）没有共同实词 */
const FINISH_BAD_QUESTION = {
  ...FINISH,
  questions: FINISH.questions.map((question) =>
    question.id === 2
      ? {
          ...question,
          options: ['A big book', 'A small boy', 'A house', 'A good day'],
          correctAnswer: 0,
        }
      : question,
  ),
}

const json = (payload) => ({
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  finishReason: 'stop',
})

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

/** 从调用里认出这是哪一步：规划 / 第几段 / 段内重写 / 降级 / 收尾 */
function classify(messages) {
  const last = messages.at(-1).content

  if (last.startsWith('请把一篇约')) return { type: 'plan' }
  if (last.includes('你上一次的题目不符合要求')) return { type: 'questions' }
  if (last.includes('下面是已经完成的英文正文')) return { type: 'finish' }
  if (last.includes('请用最简单的说法写')) {
    return { type: 'simplify', index: Number(last.match(/第 (\d+) 段/)?.[1]) }
  }
  if (
    last.includes('不在词表内')
    || last.includes('没有返回可用')
    || last.includes('超过本段上限')
  ) {
    return { type: 'repair', index: Number(last.match(/第 (\d+) 段/)?.[1]) }
  }

  const match = last.match(/第 (\d+)\/(\d+) 段/)
  if (match) return { type: 'segment', index: Number(match[1]) }

  return { type: 'unknown' }
}

/** 默认打桩：规划 3 段、每段一次过、收尾成功；overrides 按段号改行为 */
function mockHappyPath(overrides = {}) {
  const calls = {}

  chatJson.mockImplementation(async ({ messages }) => {
    const step = classify(messages)
    const key = step.index ?? 0
    calls[key] = (calls[key] ?? 0) + 1

    if (step.type === 'plan') return json(PLAN)
    if (step.type === 'finish') return json(FINISH)

    const override = overrides[step.index]?.(step, calls[key])
    if (override) return json({ text: override })

    return json({ text: SHORT })
  })
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('分段路径 · 正常闭环', () => {
  it('规划 → 三段并发 → 收尾，全程 0 生词，明细落库', async () => {
    await seedWords(400)
    mockHappyPath()

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()

    expect(doc.aiMeta.strategy).toBe('segmented')
    expect(doc.aiMeta.segments).toHaveLength(3)
    expect(doc.aiMeta.segments.every((item) => item.accepted && item.attempts === 1)).toBe(true)
    expect(doc.aiMeta.rounds.map((round) => round.kind)).toEqual([
      'plan',
      'segment',
      'segment',
      'segment',
      'finish',
    ])
    expect(doc.aiMeta.repairRounds).toBe(0)

    // easy 的预算是 0：分段各自通过之后，全文也不该有任何生词
    expect(doc.newWords).toHaveLength(0)
    expect(doc.aiMeta.violationsCount).toBe(0)

    // 目标词一个没写进去：只记录，不判失败
    expect(doc.targetPlan.unused.length).toBe(doc.targetPlan.requiredWords)

    // W5：覆盖度指标与 unused 同源；正文里没有目标词，覆盖率为 0
    expect(doc.aiMeta.targetUsage).toMatchObject({ coverageRate: 0, totalOccurrences: 0 })
    expect(doc.aiMeta.targetUsage.unused).toEqual(doc.targetPlan.unused)

    // 分段路径统一用 0.5 的温度
    expect(chatJson.mock.calls.every(([args]) => args.temperature === 0.5)).toBe(true)
  })

  it('某段首轮有表外词，重写后通过 → 只多调一次模型', async () => {
    await seedWords(400)
    mockHappyPath({
      1: (step, count) => (step.type === 'segment' && count === 1 ? BAD : SHORT),
    })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    const first = doc.aiMeta.segments.find((item) => item.id === 1)

    expect(first.attempts).toBe(2)
    expect(first.accepted).toBe(true)
    expect(doc.aiMeta.segments.filter((item) => item.id !== 1).every((item) => item.attempts === 1)).toBe(true)
    expect(doc.aiMeta.repairRounds).toBe(1)
    expect(doc.aiMeta.rounds.map((round) => round.kind)).toContain('repair')
  })

  it('单段写超 maxWords×1.15 → 只重写这一段，不重写整篇（md/30 §6-2）', async () => {
    await seedWords(400)
    mockHappyPath({
      1: (step, count) => (step.type === 'segment' && count === 1 ? LONG : SHORT),
    })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    const first = doc.aiMeta.segments.find((item) => item.id === 1)
    const others = doc.aiMeta.segments.filter((item) => item.id !== 1)

    // maxWords 37 → 上限 ceil(37 × 1.15) = 43；LONG 是 62 词，必须被压回来
    expect(first.maxWords).toBe(37)
    expect(first.limitWords).toBe(43)
    expect(first.attempts).toBe(2)
    expect(first.accepted).toBe(true)
    expect(first.actualWords).toBeLessThanOrEqual(43)
    expect(first.overLength).toBeFalsy()

    // 只重写第 1 段：其余段仍是一次过，整篇没有走整篇重写
    expect(others.every((item) => item.attempts === 1)).toBe(true)
    expect(doc.aiMeta.repairRounds).toBe(1)

    // 重写提示词要说清楚「差多少」，否则模型只会再写一遍同样的长度
    const prompts = chatJson.mock.calls.map(([args]) => args.messages.at(-1).content)
    const lengthPrompt = prompts.find((content) => content.includes('超过本段上限'))

    expect(lengthPrompt).toContain('有 61 个英文单词')
    expect(lengthPrompt).toContain('上限 43 个词')
  })

  it('词表干净但怎么都压不下来 → 收下这一段并标 overLength，不丢段', async () => {
    await seedWords(400)
    mockHappyPath({ 1: () => LONG })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    // 3 段 × 62 词 = 186，超了 100 词的验收上界，但段都在、词表干净，
    // 整篇照样收下（篇幅超长只记 lengthStatus，不判失败）
    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    const first = doc.aiMeta.segments.find((item) => item.id === 1)

    // 首轮 + 2 次段内重写 + 1 次降级，全部超长，但词表干净
    expect(first.accepted).toBe(true)
    expect(first.overLength).toBe(true)
    expect(first.attempts).toBe(4)
    expect(first.actualWords).toBe(61)
  })
})

describe('分段路径 · 题目修正（W11 缺口 1）', () => {
  it('收尾题目不合格 → 只重出题目一次，正文与标题不动', async () => {
    await seedWords(400)

    let finishCalls = 0
    chatJson.mockImplementation(async ({ messages }) => {
      const step = classify(messages)
      if (step.type === 'plan') return json(PLAN)
      if (step.type === 'finish') {
        finishCalls += 1
        return json(finishCalls === 1 ? FINISH_BAD_QUESTION : FINISH)
      }
      if (step.type === 'questions') return json(FINISH)

      return json({ text: SHORT })
    })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()

    expect(doc.aiMeta.rounds.map((round) => round.kind)).toEqual([
      'plan',
      'segment',
      'segment',
      'segment',
      'finish',
      'repair',
    ])
    expect(doc.aiMeta.rounds.at(-1).repairFor).toBe('questions')
    expect(doc.aiMeta.repairRounds).toBe(1)
    // 正文来自分段拼装，修复轮只换题目
    expect(doc.article).toContain(SHORT)
    expect(doc.title).toBe('A Good Day')
    expect(doc.questions.find((item) => item.id === 2).options[0]).toBe('good friends')
  })

  it('重出题目仍不合格 → 502，失败样本留下 questions 轮', async () => {
    await seedWords(400)

    chatJson.mockImplementation(async ({ messages }) => {
      const step = classify(messages)
      if (step.type === 'plan') return json(PLAN)
      if (step.type === 'finish' || step.type === 'questions') return json(FINISH_BAD_QUESTION)

      return json({ text: SHORT })
    })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE')

    const [failure] = await GenerationFailure.find().lean()

    expect(failure.errorCode).toBe('AI_INVALID_RESPONSE')
    expect(failure.rounds.map((round) => round.kind)).toEqual([
      'plan',
      'segment',
      'segment',
      'segment',
      'finish',
      'repair',
    ])
    expect(failure.rounds.at(-1).repairFor).toBe('questions')
    expect(failure.rounds.at(-1).feedbackType).toBe('questions')
    expect(failure.repairRounds).toBe(1)
  })
})

describe('分段路径 · 降级链', () => {
  it('某段永不通过 → 丢弃该段，整条链路仍 201，总长落在验收区间', async () => {
    // 基础词三档统一 600 之后，hard 的已知词门 3778 要靠个人词库补到 3160 个
    await seedWords(3200)
    // hard/600 → 10 段；丢 1 段后 9 段仍 ≥ 510 词
    chatJson.mockImplementation(async ({ messages }) => {
      const step = classify(messages)
      if (step.type === 'plan') return json(PLAN)
      if (step.type === 'finish') return json(FINISH)

      return json({ text: step.index === 7 ? BAD : LONG })
    })

    const res = await generate({ level: 'hard', targetWords: 600, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    const dropped = doc.aiMeta.segments.find((item) => item.id === 7)

    expect(doc.aiMeta.segments).toHaveLength(10)
    expect(dropped.accepted).toBe(false)
    // 首轮 + 2 次重写 + 1 次降级 + 补段 1 次（md/27 §3.2 M1）
    expect(dropped.attempts).toBe(5)
    expect(dropped.refilled).toBe(true)
    expect(doc.actualWords).toBeGreaterThanOrEqual(510)
    expect(doc.actualWords).toBeLessThanOrEqual(690)
  })

  it('某段首轮被丢 → 补段写回原位，段数不减少', async () => {
    await seedWords(400)
    // 第 2 段首轮 4 次全违规（首轮 + 2 重写 + 1 降级），补段那次才写对
    // 注意不能只判 type === 'segment'：重写/降级那几次是 repair，会漏过去直接算成功
    mockHappyPath({
      2: (step, count) => (count <= 4 ? BAD : SHORT),
    })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    const second = doc.aiMeta.segments.find((item) => item.id === 2)

    expect(second.accepted).toBe(true)
    expect(second.refilled).toBe(true)
    // 首轮 4 次 + 补段 1 次，统计要累加
    expect(second.attempts).toBe(5)
    expect(doc.aiMeta.segments).toHaveLength(3)
    expect(doc.aiMeta.segments.every((item) => item.accepted)).toBe(true)
  })

  it('丢段太多（接收率 < 60%）→ 502 ARTICLE_TOO_INCOMPLETE，且不再调收尾', async () => {
    await seedWords(400)
    // 3 段只成 1 段 = 33%，低于 minSegmentAcceptance 0.6
    mockHappyPath({ 2: () => BAD, 3: () => BAD })

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('ARTICLE_TOO_INCOMPLETE')
    expect(res.body.error.details).toMatchObject({
      kind: 'segment_acceptance',
      accepted: 1,
      total: 3,
    })

    // 正文注定不完整，不该再花一次收尾调用
    const finishCalled = chatJson.mock.calls.some(
      ([args]) => classify(args.messages).type === 'finish',
    )
    expect(finishCalled).toBe(false)
    expect(await Reading.countDocuments()).toBe(0)

    const [failure] = await GenerationFailure.find().lean()
    expect(failure.errorCode).toBe('ARTICLE_TOO_INCOMPLETE')
  })
})

describe('分段路径 · 取消', () => {
  it('任一段 AbortError → 整体结束，不落 GenerationFailure', async () => {
    await seedWords(400)

    const controller = new AbortController()
    let aborted = false

    chatJson.mockImplementation(async ({ messages }) => {
      const step = classify(messages)
      if (step.type === 'plan') return json(PLAN)

      const abort = () => {
        aborted = true
        controller.abort()
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }

      if (aborted) return abort()
      if (step.type === 'segment' && step.index === 2) return abort()
      if (step.type === 'finish') return json(FINISH)

      return json({ text: SHORT })
    })

    await expect(
      generateReading({
        userId: config.defaultUserId,
        body: { level: 'easy', targetWords: 100, questionCount: 3 },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(await GenerationFailure.countDocuments()).toBe(0)
    expect(await Reading.countDocuments()).toBe(0)
  })
})
