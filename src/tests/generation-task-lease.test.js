import mongoose from 'mongoose'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 任务租约（md/31 §11 多实例）。
 *
 * 这三个字段（owner / heartbeatAt / cancelRequested）存在的唯一理由是：
 * 启动清理不能再「谁重启谁把全表 running 标失败」。所以这里测的也是那条边界——
 * **只回收心跳过期的**，以及「取消落到别的实例上」时状态仍然是准的。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { generationTaskRepository } = await import(
  '../modules/readings/generation-task.repository.js'
)
const { INSTANCE_ID, reclaimInterruptedTasks } = await import(
  '../modules/readings/generation-task.service.js'
)
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const payload = {
  title: 'A Good Day',
  article: ARTICLE,
  // 翻译有 20 字下限（ai.schema），太短会被判结构不合法并触发修正轮
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

const reply = (data) => ({
  content: JSON.stringify(data),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

const postTask = (body) => request(app).post('/api/readings/generate/tasks').send(body)
const getTask = (taskId) => request(app).get(`/api/readings/generate/tasks/${taskId}`)
const cancelTask = (taskId) => request(app).post(`/api/readings/generate/tasks/${taskId}/cancel`)

/** 一个外部能控制的挂起下游：用来把任务停在 running 状态 */
function deferredChat() {
  const pending = []

  chatJson.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  )

  return {
    release(data = payload) {
      for (const item of pending.splice(0)) item.resolve(reply(data))
    },
    get size() {
      return pending.length
    },
  }
}

async function waitFor(check, { timeoutMs = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  return null
}

/**
 * 一边放行挂起的调用、一边轮询。
 * 整篇路径可能还有修正轮——只 release 一次会把第二个调用留在半空中。
 */
async function finishWithGate(taskId, gate, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    if (gate.size > 0) gate.release()

    last = await getTask(taskId)
    if (['succeeded', 'failed', 'cancelled'].includes(last.body?.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return last
}


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

/** 直接落库一条任务：绕开接口，用来构造「别的实例正在跑」这种状态 */
function insertTask(fields) {
  const _id = new mongoose.Types.ObjectId()
  const now = new Date()

  return GenerationTask.collection
    .insertOne({
      _id,
      userId: config.defaultUserId,
      status: 'running',
      stage: 'generating',
      params: { level: 'easy', targetWords: 100, questionCount: 3, vocabScope: ['all'] },
      progress: { done: 0, total: 3 },
      selectedWords: [],
      segments: [],
      names: [],
      retryCount: 0,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
    .then(() => _id)
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('租约 · 执行中的任务归谁', () => {
  it('运行中写入本实例 id 与心跳，成功交还租约', async () => {
    await seedWords()
    const gate = deferredChat()

    const { body } = await postTask(BODY)
    expect(await waitFor(() => gate.size > 0)).toBe(true)

    const running = await GenerationTask.findById(body.taskId).lean()
    expect(running.owner).toBe(INSTANCE_ID)
    expect(running.heartbeatAt instanceof Date).toBe(true)

    const done = await finishWithGate(body.taskId, gate)
    expect(done.body.status).toBe('succeeded')

    const finished = await GenerationTask.findById(body.taskId).lean()
    expect(finished.owner).toBeNull()
    expect(finished.heartbeatAt).toBeNull()
  })

  it('抢占是排他的：同一个 queued 任务只有一个实例能跑', async () => {
    const id = await insertTask({ status: 'queued', stage: 'queued' })

    const first = await generationTaskRepository.claim(id, { owner: 'instance-a', now: new Date() })
    const second = await generationTaskRepository.claim(id, { owner: 'instance-b', now: new Date() })

    expect(first.owner).toBe('instance-a')
    expect(first.status).toBe('running')
    expect(second).toBeNull()

    // 心跳只认持有者：抢输的那个续不上租，也就不会继续跑
    expect(await generationTaskRepository.heartbeat(id, 'instance-b', new Date())).toBeNull()
    expect(await generationTaskRepository.heartbeat(id, 'instance-a', new Date())).not.toBeNull()
  })
})

describe('租约 · 回收失联任务', () => {
  it('只收心跳过期的：别的实例正在跑的任务一个都不能动', async () => {
    const now = new Date()
    const stale = new Date(Date.now() - config.taskStaleMs - 60_000)

    const fresh = await insertTask({ owner: 'instance-a', heartbeatAt: now })
    const expired = await insertTask({ owner: 'instance-b', heartbeatAt: stale })
    // 加租约之前留下的文档：没有心跳，确实没有实例在续租
    const legacy = await insertTask({ owner: null, heartbeatAt: null })
    const freshQueued = await insertTask({ status: 'queued', stage: 'queued', updatedAt: now })
    const staleQueued = await insertTask({ status: 'queued', stage: 'queued', updatedAt: stale })

    const count = await reclaimInterruptedTasks()
    expect(count).toBe(3)

    const read = async (id) => (await GenerationTask.findById(id).lean()).status

    expect(await read(fresh)).toBe('running')
    expect(await read(expired)).toBe('failed')
    expect(await read(legacy)).toBe('failed')
    expect(await read(freshQueued)).toBe('queued')
    expect(await read(staleQueued)).toBe('failed')

    const failed = await GenerationTask.findById(expired).lean()
    expect(failed.error.code).toBe('TASK_INTERRUPTED')
    expect(failed.owner).toBeNull()
  })
})

describe('租约 · 跨实例取消', () => {
  it('取消请求落在别的实例上时，状态与标记都写进库里', async () => {
    const id = await insertTask({
      status: 'running',
      stage: 'generating',
      owner: 'another-instance',
      heartbeatAt: new Date(),
    })

    const res = await cancelTask(id)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(res.body.stage).toBe('done')

    const stored = await GenerationTask.findById(id).lean()

    // 持有者靠这两样停手：心跳查不到（owner 已清空）或读到 cancelRequested
    expect(stored.cancelRequested).toBe(true)
    expect(stored.owner).toBeNull()
    expect(stored.status).toBe('cancelled')
  })
})
