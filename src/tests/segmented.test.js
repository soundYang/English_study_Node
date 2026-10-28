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
  if (last.includes('下面是已经完成的英文正文')) return { type: 'finish' }
  if (last.includes('请用最简单的说法写')) {
    return { type: 'simplify', index: Number(last.match(/第 (\d+) 段/)?.[1]) }
  }
  if (last.includes('不在词表内') || last.includes('没有返回可用')) {
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
})

describe('分段路径 · 降级链', () => {
  it('某段永不通过 → 丢弃该段，整条链路仍 201，总长落在验收区间', async () => {
    await seedWords(1200)
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
    // 首轮 + 2 次重写 + 1 次降级
    expect(dropped.attempts).toBe(4)
    expect(doc.actualWords).toBeGreaterThanOrEqual(510)
    expect(doc.actualWords).toBeLessThanOrEqual(690)
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
