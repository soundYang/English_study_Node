import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 每日额度 × 生成链路（md/35 §8、§11.3）。
 *
 * 覆盖最容易出错的三类：
 *   1. 幂等复用不能重复扣；
 *   2. 失败 / 零产出取消要退，有产出的取消不退；
 *   3. 匿名请求不能出现 acct:local-user 桶。
 *
 * 上游一律打桩（同 generation-task.test.js），异步执行靠轮询到终态。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

process.env.DAILY_QUOTA_ENABLED = 'true'
process.env.DAILY_QUOTA_ACCOUNT = '3'
process.env.DAILY_QUOTA_DEVICE = '3'
process.env.DAILY_QUOTA_NETWORK = '10'

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')
const { User } = await import('../modules/auth/user.model.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Quota } = await import('../modules/quota/quota.model.js')
const { quotaDay } = await import('../modules/quota/quota.service.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

const DEVICE = 'device-0123456789abcdef'
const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

function makePayload({ questionCount = 3 } = {}) {
  return {
    title: 'A Good Day',
    article: ARTICLE,
    translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
    names: ['Tom'],
    questions: Array.from({ length: questionCount }, (_, index) => ({
      id: index + 1,
      question: `Question number ${index + 1} about the story?`,
      type: 'detail',
      evidence: 'Tom is a good boy.',
      options: ['Tom', 'book', 'house', 'friends'],
      correctAnswer: 0,
      explanation: '根据文章内容可知。',
    })),
  }
}

const reply = (payload) => ({
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

function seedWords(userId = config.defaultUserId, count = 400) {
  return Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )
}

/** 建任务：默认匿名 + 设备头；要登录就传 token */
const postTask = ({ body = BODY, token = null, deviceId = DEVICE, headers = {} } = {}) => {
  let req = request(app).post('/api/readings/generate/tasks')

  if (token) req = req.set('Authorization', `Bearer ${token}`)
  if (deviceId) req = req.set('X-Device-Id', deviceId)
  for (const [key, value] of Object.entries(headers)) req = req.set(key, value)

  return req.send(body)
}

const cancelTask = (taskId) => request(app).post(`/api/readings/generate/tasks/${taskId}/cancel`)
const retryTask = (taskId, deviceId = DEVICE) => {
  const req = request(app).post(`/api/readings/generate/tasks/${taskId}/retry`)
  return deviceId ? req.set('X-Device-Id', deviceId) : req
}

async function waitForFinish(taskId, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    last = await request(app).get(`/api/readings/generate/tasks/${taskId}`)
    if (['succeeded', 'failed', 'cancelled'].includes(last.body?.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return last
}

/** 等一个真实条件成立（退款发生在状态写回之后，不能立刻断言） */
async function waitFor(check, { timeoutMs = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  return null
}

/** 某个键今天的已用次数 */
async function usedOf(key) {
  const doc = await Quota.findOne({ key, day: quotaDay() })
  return doc?.used ?? 0
}

const deviceKey = (deviceId = DEVICE) => `dev:${deviceId}`

async function register(username = 'QuotaUser') {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username,
    password: 'Passw0rd1',
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)

  const stored = await User.findOne({ usernameLower: username.toLowerCase() })
  return { token: res.body.token, dataKey: stored.dataKey }
}

beforeEach(() => {
  chatJson.mockReset()
})

afterEach(() => {
  chatJson.mockReset()
})

describe('额度上限', () => {
  it('匿名第 4 个任务 → 429 QUOTA_EXCEEDED（设备档），带 Retry-After', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    for (let round = 1; round <= 3; round += 1) {
      const res = await postTask()
      expect(res.status).toBe(202)

      const done = await waitForFinish(res.body.taskId)
      expect(done.body.status).toBe('succeeded')
    }

    const blocked = await postTask()

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED')
    expect(blocked.body.error.details).toMatchObject({ scope: 'device', limit: 3, used: 3 })
    // 恢复方式是「等明天 0 点」：秒数落在 (0, 24h] 内，且与 resetAt 对得上
    const retryAfter = Number(blocked.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60)
    expect(Date.parse(blocked.body.error.details.resetAt) - Date.now()).toBeLessThanOrEqual(
      retryAfter * 1000,
    )
  })

  it('同一个 clientToken 重复提交只扣一次', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))
    const body = { ...BODY, clientToken: 'quota-idem-token' }

    const first = await postTask({ body })
    const second = await postTask({ body })

    expect(second.body.reused).toBe(true)
    expect(second.body.taskId).toBe(first.body.taskId)
    expect(await usedOf(deviceKey())).toBe(1)

    await waitForFinish(first.body.taskId)
  })
})

describe('退还', () => {
  it('生成失败 → 额度退回，可以继续建任务', async () => {
    await seedWords()
    chatJson.mockRejectedValue(Object.assign(new Error('upstream down'), { code: 'AI_PROVIDER_ERROR' }))

    const res = await postTask()
    expect(res.status).toBe(202)

    const done = await waitForFinish(res.body.taskId)
    expect(done.body.status).toBe('failed')

    // 状态先写、退款后写，要等退款落地
    expect(await waitFor(() => usedOf(deviceKey()).then((used) => used === 0))).toBe(true)
  })

  it('失败后重试 → 重新占用一次；成功后保持占用', async () => {
    await seedWords()
    chatJson.mockRejectedValue(Object.assign(new Error('upstream down'), { code: 'AI_PROVIDER_ERROR' }))

    const { body } = await postTask()
    await waitForFinish(body.taskId)
    expect(await waitFor(() => usedOf(deviceKey()).then((used) => used === 0))).toBe(true)

    chatJson.mockReset()
    chatJson.mockResolvedValue(reply(makePayload()))

    const retried = await retryTask(body.taskId)
    expect(retried.status).toBe(202)
    expect(retried.body.reused).toBe(false)

    const done = await waitForFinish(body.taskId)
    expect(done.body.status).toBe('succeeded')
    expect(await usedOf(deviceKey())).toBe(1)
  })

  it('零产出的取消 → 退还', async () => {
    await seedWords()

    // 让生成先挂着，保证取消时还没有任何段落产出；取消后再放行，
    // 让 runTask 正常收尾（否则心跳定时器会一直挂到这个文件结束）
    let release = null
    chatJson.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve(reply(makePayload()))
      }),
    )

    const res = await postTask()
    expect(res.status).toBe(202)
    expect(await usedOf(deviceKey())).toBe(1)

    const cancelled = await cancelTask(res.body.taskId)
    expect(cancelled.body.status).toBe('cancelled')
    expect(await usedOf(deviceKey())).toBe(0)

    release?.()
    // 迟到的写回不能把 cancelled 改回去，也不能把刚退的额度再扣一次
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await usedOf(deviceKey())).toBe(0)
  })

  it('已有产出的取消 → 不退（否则可以「取消-重试」无限白嫖）', async () => {
    await seedWords()

    // 直接造一个已经写完 2 段的任务，模拟「生成到一半用户点了取消」
    const task = await GenerationTask.create({
      userId: config.defaultUserId,
      status: 'running',
      stage: 'generating',
      params: { level: 'easy', targetWords: 100, questionCount: 3, vocabScope: ['all'] },
      progress: { done: 2, total: 5 },
      segments: [
        { index: 1, status: 'accepted', words: 80, attempts: 1, text: 'Some text.' },
        { index: 2, status: 'accepted', words: 70, attempts: 1, text: 'More text.' },
      ],
      quota: { keys: [deviceKey(), 'net:whatever'], day: quotaDay() },
    })

    await Quota.create({
      key: deviceKey(),
      day: quotaDay(),
      used: 1,
      expireAt: new Date(Date.now() + 86_400_000),
    })

    const cancelled = await cancelTask(task._id)
    expect(cancelled.body.status).toBe('cancelled')

    // 已经收下的段是真实花掉的 token，不能退
    expect(await usedOf(deviceKey())).toBe(1)
  })
})

describe('身份口径', () => {
  it('匿名请求只产生 dev / net 桶，绝不出现 acct:local-user', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await postTask()
    await waitForFinish(res.body.taskId)

    expect(await Quota.countDocuments({ key: 'acct:local-user' })).toBe(0)
    expect(await usedOf(deviceKey())).toBe(1)

    const keys = (await Quota.find({ day: quotaDay() }).lean()).map((doc) => doc.key)
    expect(keys.every((key) => key.startsWith('dev:') || key.startsWith('net:'))).toBe(true)
  })

  it('登录用户会多出 acct:<dataKey> 桶', async () => {
    const { token, dataKey } = await register()
    await seedWords(dataKey)
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await postTask({ token })
    await waitForFinish(res.body.taskId)

    expect(await usedOf(`acct:${dataKey}`)).toBe(1)
    expect(await usedOf(deviceKey())).toBe(1)
  })

  it('缺设备头 → 只按网络档限，不报错', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await postTask({ deviceId: null })

    expect(res.status).toBe(202)
    await waitForFinish(res.body.taskId)
    expect(await Quota.countDocuments({ day: quotaDay(), key: /^dev:/ })).toBe(0)
  })

  it('非法设备头 → 当作没传，不是 400', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await postTask({ deviceId: 'abc' })

    expect(res.status).toBe(202)
    await waitForFinish(res.body.taskId)
  })
})

describe('GET /api/quota', () => {
  it('匿名 + 设备头：主额度是设备，没有账号档', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await postTask()
    await waitForFinish(res.body.taskId)

    const quota = await request(app).get('/api/quota').set('X-Device-Id', DEVICE)

    expect(quota.status).toBe(200)
    expect(quota.body.primary).toEqual({ scope: 'device', limit: 3, used: 1, remaining: 2 })
    expect(quota.body.blocking).toBeNull()
    expect(quota.body.breakdown.map((item) => item.scope)).toEqual(['device', 'network'])
    expect(quota.body.day).toBe(quotaDay())
  })
})
