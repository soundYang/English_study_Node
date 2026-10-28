import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 段级续跑（md/31 §11）。
 *
 * 与 generation-task.test.js 的分工：那个文件测任务外壳在整篇路径下的行为，
 * 这个文件把策略调成 segmented，只验证一件事——
 * **重试只补失败的段，已经收下的正文不再调模型**。
 *
 * 为什么单独一个文件：`config` 是冻结对象，策略只能在模块加载前用 vi.mock 改，
 * 而同一个测试文件里改不了第二遍。
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
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 只用 easy 基础词：任何一段单独校验都应通过 */
const SHORT =
  'A good boy has a big book. The boy and his book play in the house. They are good friends.'

/** 带一个表外词：重写与降级都改不回来，这一段必然被丢 */
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
  questions: [1, 2, 3].map((id) => ({
    id,
    question: `What is question number ${id} about?`,
    type: 'detail',
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

const seedWords = (count) =>
  Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )

const postTask = (body) => request(app).post('/api/readings/generate/tasks').send(body)
const getTask = (taskId) => request(app).get(`/api/readings/generate/tasks/${taskId}`)
const retryTask = (taskId) => request(app).post(`/api/readings/generate/tasks/${taskId}/retry`)

const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

/** 从提示词认出这一步是什么：规划 / 第几段 / 收尾 */
function classify(messages) {
  const last = messages.at(-1).content

  if (last.startsWith('请把一篇约')) return { type: 'plan' }
  if (last.includes('下面是已经完成的英文正文')) return { type: 'finish' }

  const match = last.match(/第 (\d+)\/(\d+) 段/)
  if (match) return { type: 'segment', index: Number(match[1]) }

  // 重写 / 降级 / 补段的提示词里也带「第 N 段」：续跑断言只数 segment，
  // 但第一轮打桩要靠 index 把这些调用一起打成坏样本
  const repair = last.match(/第 (\d+) 段/)
  if (repair) return { type: 'repair', index: Number(repair[1]) }

  return { type: 'other' }
}

async function waitForFinish(taskId, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    last = await getTask(taskId)
    if (['succeeded', 'failed', 'cancelled'].includes(last.body?.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return last
}

describe('分段任务的失败与续跑', () => {
  beforeEach(() => {
    chatJson.mockReset()
  })

  it('重试只补被丢掉的段：已收下的正文不重新生成，计划也不再重跑', async () => {
    await seedWords(400)

    // 第一轮：第 1 段合格，第 2、3 段永远写不出合规正文
    // （3 段只收 1 段 = 33%，低于 minSegmentAcceptance，任务判失败）
    let phase = 'first'
    const retryCalls = []

    chatJson.mockImplementation(async ({ messages }) => {
      const step = classify(messages)

      if (phase === 'retry') retryCalls.push(step)

      if (step.type === 'plan') return json(PLAN)
      if (step.type === 'finish') return json(FINISH)

      if (phase === 'first' && (step.index === 2 || step.index === 3)) return json({ text: BAD })

      return json({ text: SHORT })
    })

    const { body } = await postTask(BODY)
    const failed = await waitForFinish(body.taskId)

    expect(failed.body.status).toBe('failed')
    expect(failed.body.error.code).toBe('ARTICLE_TOO_INCOMPLETE')
    expect(failed.body.retryable).toBe(true)

    // 失败前已经落库的东西：计划（含提示词与段级预算）+ 第 1 段正文
    const stored = await GenerationTask.findById(body.taskId)
    expect(stored.plan.systemPrompt).toBeTruthy()
    expect(stored.plan.segments).toHaveLength(3)
    expect(stored.plan.segments.every((segment) => segment.limitWords > 0)).toBe(true)
    expect(stored.segments.find((segment) => segment.index === 1).status).toBe('accepted')
    expect(stored.segments.find((segment) => segment.index === 1).text).toBe(SHORT)

    // 第二轮：同样的输入，这次每一段都能写出来
    phase = 'retry'

    const res = await retryTask(body.taskId)

    expect(res.status).toBe(202)
    expect(res.body.reused).toBe(false)
    expect(res.body.retryCount).toBe(1)

    const done = await waitForFinish(body.taskId)

    expect(done.body.status).toBe('succeeded')
    expect(done.body.retryCount).toBe(1)

    // 续跑不重新规划：分段、提示词、段级预算都是第一次跑的那份
    expect(retryCalls.filter((step) => step.type === 'plan')).toHaveLength(0)

    // 只调了第 2、3 段：第 1 段用的就是库里存下来的正文
    const segmentIndexes = retryCalls
      .filter((step) => step.type === 'segment')
      .map((step) => step.index)
      .sort()

    expect(segmentIndexes).toEqual([2, 3])

    const article = await request(app).get(`/api/readings/${done.body.readingId}`)

    expect(article.status).toBe(200)
    // 三段拼起来，其中第 1 段是原来那一段（不是重新生成的）
    expect(article.body.article.split(SHORT)).toHaveLength(4)
  })
})
