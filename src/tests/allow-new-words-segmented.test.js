import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 生词容忍在分段路径上的落法（md/41）。
 *
 * 段是并发生成的，没法共享「已用额度」计数器，所以额度按段号静态分配：
 * 前 `unknownBudget` 段各 1 个，其余 0。这样「每段都不超过自己的额度」
 * 就等价于「全篇收下的不同生词 ≤ 预算」。
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
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 只用基础词，任何一段单独校验都应通过 */
const SHORT =
  'A good boy has a big book. The boy and his book play in the house. They are good friends.'

const PLAN_100 = {
  segments: [
    { id: 1, goal: '介绍男孩和他的书', mustUse: [], maxWords: 37 },
    { id: 2, goal: '写他们在房子里玩', mustUse: [], maxWords: 37 },
    { id: 3, goal: '写他们是好朋友', mustUse: [], maxWords: 37 },
  ],
}

const PLAN_200 = {
  segments: Array.from({ length: 4 }, (_, index) => ({
    id: index + 1,
    goal: `写故事的第 ${index + 1} 部分`,
    mustUse: [],
    maxWords: 50,
  })),
}

const FINISH = {
  title: 'A Good Day',
  translation: '一个男孩有一本很大的书，他和书在房子里玩，他们是好朋友。',
  names: [],
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
  usage: { prompt_tokens: 10, completion_tokens: 20 },
  finishReason: 'stop',
})

const seedWords = (count = 1300) =>
  Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )

const generate = (body) => request(app).post('/api/readings/generate').send(body)

/** 从调用里认出这一步是规划 / 第几段 / 段内重写 / 收尾（与 segmented.test.js 同口径） */
function classify(messages) {
  const last = messages.at(-1).content

  if (last.startsWith('请把一篇约')) return { type: 'plan' }
  if (last.includes('你上一次的题目不符合要求')) return { type: 'questions' }
  if (last.includes('下面是已经完成的英文正文')) return { type: 'finish' }
  if (last.includes('请用最简单的说法写')) {
    return { type: 'repair', index: Number(last.match(/第 (\d+) 段/)?.[1]) }
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

/**
 * 规划 → 各段按 `segmentText(index)` 返回 → 收尾成功。
 * 段内重写与降级也走同一个函数：想模拟「怎么改都带生词」时返回同一段即可。
 */
function mockSegments({ plan, segmentText = () => SHORT }) {
  chatJson.mockImplementation(async ({ messages }) => {
    const step = classify(messages)

    if (step.type === 'plan') return json(plan)
    if (step.type === 'finish') return json(FINISH)
    if (step.type === 'segment' || step.type === 'repair') {
      return json({ text: segmentText(step.index) })
    }

    return json({ text: SHORT })
  })
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('分段路径 · allowNewWords', () => {
  it('打开后第 1 段带 1 个生词直接收下：额度 1，一次通过', async () => {
    await seedWords()
    mockSegments({
      plan: PLAN_100,
      segmentText: (index) => (index === 1 ? `${SHORT} Quizzical.` : SHORT),
    })

    const res = await generate({
      level: 'medium',
      targetWords: 100,
      questionCount: 3,
      allowNewWords: true,
    })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.newWords.map((item) => item.word)).toEqual(['quizzical'])
    expect(doc.aiMeta.allowNewWords).toBe(true)
    expect(doc.aiMeta.unknownBudget).toBe(3)

    const first = doc.aiMeta.segments.find((item) => item.id === 1)

    expect(first).toMatchObject({ accepted: true, attempts: 1, unknownAllowance: 1 })
    // medium 预算 3 ≥ 段数 3：每段都分到 1 个额度（每段仍最多 1 个）
    expect(doc.aiMeta.segments.every((item) => item.unknownAllowance === 1)).toBe(true)
  })

  it('默认关：同样的段会被重写并最终丢弃，文章里没有一个生词', async () => {
    await seedWords()
    mockSegments({
      plan: PLAN_100,
      segmentText: (index) => (index === 1 ? `${SHORT} Quizzical.` : SHORT),
    })

    const res = await generate({ level: 'medium', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.newWords).toEqual([])
    expect(doc.aiMeta.allowNewWords).toBe(false)

    const first = doc.aiMeta.segments.find((item) => item.id === 1)
    expect(first.accepted).toBe(false)
    expect(first.attempts).toBeGreaterThan(1)

    // 2/3 ≥ minSegmentAcceptance，残篇仍然放行——丢段是段级闭环的既定行为
    expect(doc.aiMeta.segments.filter((item) => item.accepted)).toHaveLength(2)
  })

  it('200 词分 4 段、预算 3：前 3 段各收 1 个，第 4 段被丢弃', async () => {
    await seedWords()
    const unknown = ['Quizzical.', 'Zephyrish.', 'Brontide.', 'Crepuscule.']
    mockSegments({
      plan: PLAN_200,
      segmentText: (index) => `${SHORT} ${unknown[index - 1]}`,
    })

    const res = await generate({
      level: 'medium',
      targetWords: 200,
      questionCount: 3,
      allowNewWords: true,
    })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()

    // 全篇只收下 3 个不同的生词，第 4 段没有额度，重写/补段都过不了
    expect(doc.newWords).toHaveLength(3)
    expect(doc.aiMeta.segments.map((item) => item.accepted)).toEqual([true, true, true, false])
    expect(doc.aiMeta.segments.map((item) => item.unknownAllowance)).toEqual([1, 1, 1, 0])
  })
})
