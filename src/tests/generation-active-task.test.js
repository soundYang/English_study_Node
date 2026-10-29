import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 每用户唯一活跃任务（md/55 §4.3）。
 *
 * 「先查再建」在并发下有两个窗口：两个请求都查到没有活跃任务，然后都 create。
 * 这里用并发请求钉住 activeKey 唯一索引：最终只能有一个任务、扣一次钱。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const payload = {
  title: 'A Good Day',
  article: ARTICLE,
  translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
  names: ['Tom'],
  questions: [1, 2, 3].map((id) => ({
    id,
    question: `Question ${id}?`,
    type: 'detail',
    evidence: 'Tom is a good boy.',
    options: ['Tom', 'book', 'house', 'friends'],
    correctAnswer: 0,
    explanation: '根据文章内容可知。',
  })),
}

const reply = {
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
  finishReason: 'stop',
}

/** 挂起所有模型调用，让两个创建请求真正并发 */
function deferredChat() {
  const pending = []

  chatJson.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  )

  return {
    release() {
      for (const resolve of pending.splice(0)) resolve(reply)
    },
    get size() {
      return pending.length
    },
  }
}

const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }
const postTask = (body) => request(app).post('/api/readings/generate/tasks').send(body)

function seedWords(count = 400) {
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

async function finish(taskId, gate, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    if (gate.size > 0) gate.release()

    const res = await request(app).get(`/api/readings/generate/tasks/${taskId}`)
    last = res.body
    if (['succeeded', 'failed', 'cancelled'].includes(last?.status)) return last

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return last
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('activeKey 唯一活跃任务', () => {
  it('同参并发创建只留一个任务，两个响应指向同一个 taskId', async () => {
    await seedWords()
    const gate = deferredChat()

    const [first, second] = await Promise.all([postTask(BODY), postTask(BODY)])

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(first.body.taskId).toBe(second.body.taskId)
    expect(await GenerationTask.countDocuments({})).toBe(1)

    await finish(first.body.taskId, gate)
  })

  it('不同参并发创建只有一个能建，另一个 409 TASK_IN_PROGRESS', async () => {
    await seedWords()
    const gate = deferredChat()

    const [first, second] = await Promise.all([
      postTask(BODY),
      postTask({ ...BODY, targetWords: 200 }),
    ])

    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([202, 409])

    const conflict = first.status === 409 ? first : second
    expect(conflict.body.error.code).toBe('TASK_IN_PROGRESS')
    expect(await GenerationTask.countDocuments({})).toBe(1)

    const created = first.status === 202 ? first : second
    await finish(created.body.taskId, gate)
  })

  it('任务到终态后释放 activeKey，用户能建下一个任务', async () => {
    await seedWords()
    const gate = deferredChat()

    const created = await postTask(BODY)
    const done = await finish(created.body.taskId, gate)

    expect(done.status).toBe('succeeded')

    const task = await GenerationTask.findById(created.body.taskId).lean()
    expect(task.activeKey).toBeUndefined()

    const next = await postTask({ ...BODY, targetWords: 200 })
    expect(next.status).toBe(202)
    await finish(next.body.taskId, gate)
  })
})
