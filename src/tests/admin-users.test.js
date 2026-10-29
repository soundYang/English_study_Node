import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { hashPassword } from '../modules/auth/password.js'

/**
 * 用户台账（md/37 §3 / §5.2 / §9）。
 *
 * 重点不是「接口通不通」，而是**口径对不对**：
 * 词汇量不计 new / basic-removed、正确率按题数加权、token 只认事件表、
 * 额度开关关闭时不能显示成「剩余 3 次」。这些是最容易看起来对、其实全错的地方。
 */
const ADMIN_USERNAME = 'admin'
const ADMIN_PASSWORD = 'AdminPass123'

process.env.ADMIN_USERNAME = ADMIN_USERNAME
process.env.ADMIN_PASSWORD_HASH = await hashPassword(ADMIN_PASSWORD)
// 本文件验证台账里的额度口径：打开开关，库里才会有 acct: 桶
process.env.DAILY_QUOTA_ENABLED = 'true'

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { UserApiKey } = await import('../modules/ai-keys/ai-key.model.js')
const { GenerationFailure } = await import('../modules/readings/generation-failure.model.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Quota } = await import('../modules/quota/quota.model.js')
const { quotaDay } = await import('../modules/quota/quota.service.js')
const { TokenUsage } = await import('../modules/usage/token-usage.model.js')
const { User } = await import('../modules/auth/user.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

let adminTokenCache = null

// setup.js 的 afterEach 会清空所有集合（含 admin_sessions），
// 缓存的令牌到下一个用例就失效了
beforeEach(() => {
  adminTokenCache = null
})

async function adminToken() {
  if (adminTokenCache) return adminTokenCache

  const res = await request(app)
    .post('/api/admin/auth/login')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

  expect(res.status).toBe(200)
  adminTokenCache = res.body.token
  return adminTokenCache
}

async function authedGet(path) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${await adminToken()}`)
}

async function makeUser({ username, phone = null, nickname = '' }) {
  return User.create({
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: await hashPassword('Passw0rd1'),
    phone,
    nickname,
    dataKey: `dk_${username.toLowerCase()}`,
  })
}

function wordRows(userId, entries) {
  return entries.map(([word, status, source = 'manual']) => ({ userId, word, status, source }))
}

function questions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    question: `Question ${index + 1}?`,
    options: ['A', 'B', 'C', 'D'],
    correctAnswer: 0,
    explanation: '因为 A',
  }))
}

async function makeReading(userId, {
  questionCount = 3,
  correctCount = null,
  status = 'submitted',
  tokens = 0,
  createdAt,
} = {}) {
  return Reading.create({
    userId,
    title: 'A test article',
    article: 'The quick brown fox jumps over the lazy dog.',
    translation: '测试文章',
    level: 'easy',
    targetWords: 100,
    questionCount,
    actualWords: 90,
    questions: questions(questionCount),
    vocabularySnapshot: ['fox'],
    status,
    ...(status === 'submitted'
      ? {
        correctCount: correctCount ?? 0,
        score: Math.round(((correctCount ?? 0) / questionCount) * 100),
        submittedAt: new Date(),
      }
      : {}),
    aiMeta: { totalTokens: tokens },
    ...(createdAt ? { createdAt } : {}),
  })
}

async function seedUserA() {
  const user = await makeUser({ username: 'Alice', phone: '13800000000', nickname: '爱丽丝' })

  await Word.insertMany(wordRows(user.dataKey, [
    ['learning1', 'learning'],
    ['mastered1', 'mastered'],
    ['new1', 'new'],
    ['removed1', 'new', 'basic-removed'],
  ]))

  // 10 题全对 + 1 题全错 → 题数加权 10/11 = 91%，不是「两篇平均 50%」
  await makeReading(user.dataKey, { questionCount: 10, correctCount: 10, tokens: 111 })
  await makeReading(user.dataKey, { questionCount: 1, correctCount: 0, tokens: 222 })

  const okTask = await GenerationTask.create({ userId: user.dataKey, status: 'succeeded' })
  const cancelledTask = await GenerationTask.create({ userId: user.dataKey, status: 'cancelled' })

  await TokenUsage.insertMany([
    { userId: user.dataKey, taskId: okTask._id, kind: 'generate', totalTokens: 300, day: quotaDay() },
    // 取消的任务没有 reading，但钱已经花了
    { userId: user.dataKey, taskId: cancelledTask._id, kind: 'segment', totalTokens: 50, day: quotaDay() },
    { userId: user.dataKey, taskId: null, kind: 'generate', totalTokens: 20, day: quotaDay() },
  ])

  await Quota.create({
    key: `acct:${user.dataKey}`,
    day: quotaDay(),
    used: 1,
    expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  })

  return user
}

describe('GET /api/admin/users', () => {
  it('一页返回口径完整的用户行', async () => {
    const user = await seedUserA()

    const res = await authedGet('/api/admin/users')

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)

    const row = res.body.items[0]
    expect(row.dataKey).toBe(user.dataKey)
    expect(row.username).toBe('Alice')
    expect(row.nickname).toBe('爱丽丝')

    // 只算 learning / mastered：new 与 basic-removed 都不计入
    expect(row.vocabulary.personalWords).toBe(2)
    // 列表页不现算 knownWords（§7）
    expect(row.vocabulary.knownWords).toBeUndefined()

    expect(row.readings).toMatchObject({ generated: 2, completed: 2 })
    // 题数加权，不是各篇得分平均
    expect(row.questions).toMatchObject({ answered: 11, correct: 10, accuracy: 91 })

    expect(row.tokens).toMatchObject({
      total: 370,
      success: 300,
      cancelled: 50,
      sync: 20,
      failed: 0,
    })

    expect(row.quota).toMatchObject({
      enabled: true,
      limit: config.dailyQuotaAccount,
      used: 1,
      remaining: config.dailyQuotaAccount - 1,
      day: quotaDay(),
    })
  })

  it('手机号列表脱敏，但搜索用明文能命中', async () => {
    const user = await seedUserA()

    const res = await authedGet('/api/admin/users?q=13800000000')

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.items[0].dataKey).toBe(user.dataKey)
    expect(res.body.items[0].phone).toBe('138****8000')
  })

  it('按 token 排序：花得多的在前', async () => {
    const alice = await seedUserA()
    const bob = await makeUser({ username: 'Bob' })
    await TokenUsage.create({
      userId: bob.dataKey,
      taskId: null,
      kind: 'generate',
      totalTokens: 9999,
      day: quotaDay(),
    })

    const res = await authedGet('/api/admin/users?sort=tokens')

    expect(res.status).toBe(200)
    expect(res.body.items.map((item) => item.dataKey)).toEqual([bob.dataKey, alice.dataKey])
  })

  it('size 上限 100；超出直接 400', async () => {
    const tooBig = await authedGet('/api/admin/users?size=500')
    const ok = await authedGet('/api/admin/users?size=100')

    expect(tooBig.status).toBe(400)
    expect(tooBig.body.error.code).toBe('INVALID_REQUEST')
    expect(ok.status).toBe(200)
    expect(ok.body.size).toBe(100)
  })
})

describe('GET /api/admin/users/:dataKey', () => {
  it('详情给全量手机号、三档 knownWords、最近文章与失败 Top 3', async () => {
    const user = await seedUserA()
    await GenerationFailure.insertMany([
      { userId: user.dataKey, errorCode: 'AI_INVALID_RESPONSE' },
      { userId: user.dataKey, errorCode: 'AI_INVALID_RESPONSE' },
      { userId: user.dataKey, errorCode: 'VOCABULARY_TOO_SMALL' },
    ])

    const res = await authedGet(`/api/admin/users/${user.dataKey}`)

    expect(res.status).toBe(200)
    // 详情页要能联系用户，给全量
    expect(res.body.phone).toBe('13800000000')
    expect(res.body.vocabulary.personalWords).toBe(2)
    for (const level of ['easy', 'medium', 'hard']) {
      expect(typeof res.body.vocabulary.knownWords[level]).toBe('number')
      // 基础词表 + 日历词的地板（空个人词库也有几百）
      expect(res.body.vocabulary.knownWords[level]).toBeGreaterThan(500)
    }

    expect(res.body.readings).toMatchObject({ generated: 2, completed: 2, failed: 3 })
    expect(res.body.questions.accuracy).toBe(91)

    expect(res.body.recentReadings).toHaveLength(2)
    expect(res.body.recentReadings[0]).toMatchObject({
      level: 'easy',
      status: 'submitted',
      accuracy: 0,
    })

    expect(res.body.failureSummary).toEqual({
      total: 3,
      topCodes: [
        { code: 'AI_INVALID_RESPONSE', count: 2 },
        { code: 'VOCABULARY_TOO_SMALL', count: 1 },
      ],
    })
  })

  it('自备 Key：只给摘要，token 台账不把用户自己花的钱算进平台成本（md/43 §7.2 / §7.4）', async () => {
    const user = await seedUserA()
    await UserApiKey.create({
      userId: user.dataKey,
      provider: 'deepseek',
      cipher: 'v1.deadbeef.iv.tag.ct',
      last4: '1234',
      fingerprint: 'fingerprint123',
    })
    await TokenUsage.create({ userId: user.dataKey, totalTokens: 100, day: quotaDay() })
    await TokenUsage.create({
      userId: user.dataKey,
      totalTokens: 900,
      keySource: 'user',
      day: quotaDay(),
    })

    const res = await authedGet(`/api/admin/users/${user.dataKey}`)

    expect(res.status).toBe(200)
    // seedUserA 本身的 370（300 + 50 + 20）+ 这里的 100；900 属于用户自付，不算平台成本
    expect(res.body.tokens.total).toBe(470)
    expect(res.body.apiKey).toMatchObject({
      hasKey: true,
      provider: 'deepseek',
      status: 'active',
    })

    // cipher / fingerprint / 掩码 任何管理接口都不返回（§7.4）
    const raw = JSON.stringify(res.body)
    for (const secret of ['v1.deadbeef', 'fingerprint123', 'sk-****']) {
      expect(raw).not.toContain(secret)
    }
    expect(res.body.apiKey).not.toHaveProperty('maskedKey')
  })

  it('不存在的 dataKey → 404 ADMIN_USER_NOT_FOUND', async () => {
    const res = await authedGet('/api/admin/users/dk_nobody')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('ADMIN_USER_NOT_FOUND')
  })
})

describe('GET /api/admin/overview', () => {
  it('用户数 / 文章数 / 反馈计数 / 全局免费池都在', async () => {
    await seedUserA()

    const res = await authedGet('/api/admin/overview')

    expect(res.status).toBe(200)
    expect(res.body.users.total).toBe(1)
    expect(res.body.readings.total).toBe(2)
    expect(res.body.feedback).toEqual({ open: 0, replied: 0, closed: 0 })
    expect(res.body.tokens.freeBudget).toMatchObject({
      enabled: expect.any(Boolean),
      limitTokens: expect.any(Number),
      usedTokens: expect.any(Number),
    })
  })
})
