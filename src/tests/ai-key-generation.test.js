import { randomBytes } from 'node:crypto'

import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 自备 Key × 生成链路（md/43 §6 / §11.3）。
 *
 * 每日额度与免费池都打开：这两道闸「对自备 Key 不生效」正是本节要证明的事，
 * 关着的话所有用例都会通过，什么也证明不了。
 *
 * 上游打桩在 ai.client 层；`resolveAiKey` 默认走真实实现（读库 + 解密），
 * 只有「创建与执行之间 Key 状态变了」的两个用例用 ctl.override 精确控制返回，
 * 否则得靠时序竞争才能造出那个窗口。
 */

const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const ctl = vi.hoisted(() => ({ override: null }))

vi.mock('../modules/ai-keys/ai-key.service.js', async (importOriginal) => {
  const actual = await importOriginal()

  return {
    ...actual,
    resolveAiKey: (...args) =>
      (ctl.override ? ctl.override(...args) : actual.resolveAiKey(...args)),
  }
})

const SECRET = randomBytes(32).toString('base64')

process.env.USER_API_KEY_ENABLED = 'true'
process.env.USER_API_KEY_SECRET = SECRET
process.env.TOKEN_BUDGET_ENABLED = 'true'
process.env.FREE_TOKEN_BUDGET = '500'
process.env.DAILY_QUOTA_ENABLED = 'true'
process.env.DAILY_QUOTA_ACCOUNT = '3'
process.env.DAILY_QUOTA_DEVICE = '3'
process.env.DAILY_QUOTA_NETWORK = '10'

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { encryptSecret, fingerprintKey } = await import('../modules/ai-keys/ai-key.crypto.js')
const { UserApiKey } = await import('../modules/ai-keys/ai-key.model.js')
const { FREE_BUDGET_ID, TokenBudget } = await import('../modules/budget/budget.model.js')
const { Quota } = await import('../modules/quota/quota.model.js')
const { quotaDay } = await import('../modules/quota/quota.service.js')
const { GenerationFailure } = await import('../modules/readings/generation-failure.model.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { TokenUsage } = await import('../modules/usage/token-usage.model.js')
const { Word } = await import('../modules/words/word.model.js')
const { userApiKeyExpired } = await import('../shared/errors.js')

const app = createApp()

const USER_KEY = 'sk-userownkey0000000000000000000000'
const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const ACCT_KEY = `acct:${config.defaultUserId}`

function makePayload() {
  return {
    title: 'A Good Day',
    article: ARTICLE,
    translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
    names: ['Tom'],
    questions: Array.from({ length: 3 }, (_, index) => ({
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

const reply = () => ({
  content: JSON.stringify(makePayload()),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

const freeKey = () => ({
  source: 'free',
  apiKey: config.deepseekApiKey,
  provider: 'deepseek',
  keyId: null,
})

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

function seedUserKey({ apiKey = USER_KEY, cipher = null } = {}) {
  return UserApiKey.create({
    userId: config.defaultUserId,
    provider: 'deepseek',
    cipher: cipher ?? encryptSecret(apiKey),
    last4: apiKey.slice(-4),
    fingerprint: fingerprintKey(apiKey),
  })
}

const usedTokens = async () =>
  (await TokenBudget.findById(FREE_BUDGET_ID).lean())?.usedTokens ?? 0

/**
 * 当天所有额度桶的已用次数之和。
 *
 * 未登录的请求（AUTH_ENFORCED=false 的测试环境）没有账号桶，
 * 只占网络指纹桶——断言「扣了一次」必须看全部桶，不能只盯 acct:。
 */
async function quotaTotal() {
  const rows = await Quota.find({ day: quotaDay() }).lean()
  return rows.reduce((sum, row) => sum + (row.used ?? 0), 0)
}

const postGenerate = () => request(app).post('/api/readings/generate').send(BODY)
const postTask = () => request(app).post('/api/readings/generate/tasks').send(BODY)

async function waitFor(check, { timeoutMs = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  return null
}

async function waitForFinish(taskId) {
  return waitFor(async () => {
    const res = await request(app).get(`/api/readings/generate/tasks/${taskId}`)
    return ['succeeded', 'failed', 'cancelled'].includes(res.body?.status) ? res : null
  })
}

beforeEach(async () => {
  chatJson.mockReset()
  ctl.override = null
  // 额度 / 预算都是「当天」的概念，每个用例从干净的账本开始
  await Quota.deleteMany({})
  await TokenBudget.deleteMany({})
})

describe('同步生成', () => {
  it('自备 Key：免费池已耗尽也能生成，且不扣预算 / 不扣每日额度', async () => {
    await seedWords()
    await seedUserKey()
    await TokenBudget.create({ _id: FREE_BUDGET_ID, usedTokens: 500 })
    // 账号额度也已用尽：走免费路径会 429
    await Quota.create({
      key: ACCT_KEY,
      day: quotaDay(),
      used: 3,
      expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    chatJson.mockResolvedValue(reply())

    const res = await postGenerate()

    expect(res.status).toBe(201)
    expect(await usedTokens()).toBe(500)
    expect(await Quota.countDocuments({})).toBe(1)
    expect((await Quota.findOne({ key: ACCT_KEY }).lean()).used).toBe(3)

    const usage = await TokenUsage.find({ userId: config.defaultUserId }).lean()
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.every((row) => row.keySource === 'user')).toBe(true)

    const reading = await Reading.findOne({ userId: config.defaultUserId }).lean()
    expect(reading.aiMeta.keySource).toBe('user')
  })

  it('没有自备 Key：行为与现状一致（扣额度、扣预算、流水记 free）', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply())

    const res = await postGenerate()

    expect(res.status).toBe(201)
    expect(await usedTokens()).toBe(300)
    expect(await quotaTotal()).toBe(1)

    const usage = await TokenUsage.find({ userId: config.defaultUserId }).lean()
    expect(usage.every((row) => row.keySource === 'free')).toBe(true)
    expect((await Reading.findOne({}).lean()).aiMeta.keySource).toBe('free')
  })

  it('密文解不开 → 回落免费路径，额度照扣（fail-open 但不能白用）', async () => {
    await seedWords()
    // 主密钥被换掉、旧值又没留在 PREVIOUS：kid 对不上任何一把，这条 Key 谁也解不开
    await seedUserKey({ cipher: 'v1.deadbeef.AAAA.AAAA.AAAA' })
    chatJson.mockResolvedValue(reply())

    const res = await postGenerate()

    expect(res.status).toBe(201)
    expect(await usedTokens()).toBe(300)
    expect(await quotaTotal()).toBe(1)
    expect((await Reading.findOne({}).lean()).aiMeta.keySource).toBe('free')
  })

  it('生成中上游拒绝自备 Key → 403 USER_API_KEY_INVALID，并把它标成 invalid', async () => {
    await seedWords()
    await seedUserKey()
    chatJson.mockRejectedValue(userApiKeyExpired())

    const res = await postGenerate()

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('USER_API_KEY_INVALID')
    expect(
      await waitFor(async () => (await UserApiKey.findOne({}).lean())?.status === 'invalid'),
    ).toBe(true)

    // 失败样本同样带支付路径
    const failure = await GenerationFailure.findOne({ userId: config.defaultUserId }).lean()
    expect(failure.keySource).toBe('user')
    // 403 不是「登录过期」：额度该退回去（预扣前已挡住，这里断言没有被留下）
    expect(await quotaTotal()).toBe(0)
  })
})

describe('任务化生成', () => {
  it('创建时用自备 Key：不预扣额度，任务上记 aiKeySource=user', async () => {
    await seedWords()
    await seedUserKey()
    await TokenBudget.create({ _id: FREE_BUDGET_ID, usedTokens: 500 })
    chatJson.mockResolvedValue(reply())

    const created = await postTask()

    expect(created.status).toBe(202)
    const task = await GenerationTask.findById(created.body.taskId).lean()
    expect(task.aiKeySource).toBe('user')
    expect(task.quota?.keys ?? []).toEqual([])

    const done = await waitForFinish(created.body.taskId)
    expect(done.body.status).toBe('succeeded')
    expect(await usedTokens()).toBe(500)
  })

  it('创建时用自备 Key、执行前被删 → failed + USER_API_KEY_MISSING，不偷偷花免费池', async () => {
    await seedWords()
    // 第一次解析（创建）拿到 user，第二次（执行）已经没有 Key
    let calls = 0
    ctl.override = async () => {
      calls += 1
      return calls === 1
        ? { source: 'user', apiKey: USER_KEY, provider: 'deepseek', keyId: 'fake' }
        : freeKey()
    }

    const created = await postTask()
    expect(created.status).toBe(202)

    const done = await waitForFinish(created.body.taskId)
    expect(done.body.status).toBe('failed')
    expect(done.body.error.code).toBe('USER_API_KEY_MISSING')
    expect(chatJson).not.toHaveBeenCalled()
    expect(await usedTokens()).toBe(0)
  })

  it('创建时还没有 Key、执行前导入 → 改用自备 Key，并退回已占的额度', async () => {
    await seedWords()
    let calls = 0
    ctl.override = async () => {
      calls += 1
      return calls === 1
        ? freeKey()
        : { source: 'user', apiKey: USER_KEY, provider: 'deepseek', keyId: 'fake' }
    }
    chatJson.mockResolvedValue(reply())

    const created = await postTask()
    expect(created.status).toBe(202)
    expect(created.body.taskId).toBeTruthy()

    const done = await waitForFinish(created.body.taskId)
    expect(done.body.status).toBe('succeeded')

    const task = await GenerationTask.findById(created.body.taskId).lean()
    expect(task.aiKeySource).toBe('user')
    // 预扣在创建时发生，执行时发现是自备 Key → 已退回
    expect(await quotaTotal()).toBe(0)
    expect(await usedTokens()).toBe(0)
  })
})

describe('重试', () => {
  it('上次用自备 Key、这次没有 → 按免费路径重新过闸并占额度', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply())

    const task = await GenerationTask.create({
      userId: config.defaultUserId,
      status: 'failed',
      stage: 'done',
      aiKeySource: 'user',
      params: { level: 'easy', targetWords: 100, questionCount: 3, vocabScope: ['all'] },
      error: { code: 'USER_API_KEY_MISSING', message: 'key gone' },
    })

    const res = await request(app).post(`/api/readings/generate/tasks/${task._id}/retry`)

    expect(res.status).toBe(202)
    const done = await waitForFinish(task._id)
    expect(done.body.status).toBe('succeeded')

    expect((await GenerationTask.findById(task._id).lean()).aiKeySource).toBe('free')
    expect(await quotaTotal()).toBe(1)
    expect(await usedTokens()).toBe(300)
  })
})
