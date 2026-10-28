import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { resetLoginFailures } from '../modules/auth/auth.service.js'
import { createCaptcha } from '../modules/auth/captcha.service.js'
import { startOfWeek } from '../modules/auth/profile.stats.js'
import { User } from '../modules/auth/user.model.js'
import { Reading } from '../modules/readings/reading.model.js'

/**
 * GET /api/profile/stats（md/33 §9）。
 *
 * 这里要守住三个容易被「顺手改成平均分」的口径：
 *   准确率按题算、token 含未提交、柱状图固定 12 项且无数据补 0。
 */

const app = createApp()
const PASSWORD = 'Passw0rd1'
const DAY_MS = 24 * 60 * 60 * 1000

async function register(username = 'StatsUser') {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username,
    password: PASSWORD,
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)

  const stored = await User.findOne({ usernameLower: username.toLowerCase() })
  return { token: res.body.token, dataKey: stored.dataKey }
}

const getStats = (token) =>
  request(app).get('/api/profile/stats').set('Authorization', `Bearer ${token}`)

const questionsOf = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    question: `Q${index + 1}?`,
    options: ['a', 'b', 'c', 'd'],
    correctAnswer: 0,
    explanation: '解析',
  }))

async function makeReading(userId, overrides = {}) {
  const { createdAt, ...rest } = overrides
  const doc = await Reading.create({
    userId,
    title: 'A Short Text',
    article: 'This is a short text.',
    translation: '这是一段短文。',
    level: 'easy',
    targetWords: 100,
    questionCount: 3,
    actualWords: 5,
    questions: questionsOf(3),
    vocabularySnapshot: ['short'],
    names: [],
    status: 'generated',
    ...rest,
  })

  // timestamps: true 会在 insert 时写 createdAt，要造「三周前生成」的样本只能事后改，
  // { timestamps: false } 同时挡住 Mongoose 顺手更新 updatedAt
  if (createdAt) {
    await Reading.updateOne({ _id: doc._id }, { $set: { createdAt } }, { timestamps: false })
  }

  return doc
}

/** 与后端同口径的本地 YYYY-MM-DD，用来断言 weekStart */
function toKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const weeksAgo = (weeks) => new Date(startOfWeek(new Date()).getTime() - weeks * 7 * DAY_MS)

beforeEach(() => {
  resetLoginFailures()
})

describe('GET /api/profile/stats', () => {
  it('没有令牌 → 401（开关关着也必须是真登录）', async () => {
    const res = await request(app).get('/api/profile/stats')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('空数据：全 0，weekly 仍是 12 项且从 11 周前到本周递增', async () => {
    const { token } = await register()

    const res = await getStats(token)

    expect(res.status).toBe(200)
    expect(res.body.reading).toEqual({ completedCount: 0, generatedCount: 0, totalTokens: 0 })
    expect(res.body.questions).toEqual({ answered: 0, correct: 0, wrong: 0, accuracy: 0 })

    expect(res.body.weekly).toHaveLength(12)
    expect(res.body.weekly.every((item) => item.count === 0)).toBe(true)
    expect(res.body.weekly[0].weekStart).toBe(toKey(weeksAgo(11)))
    expect(res.body.weekly[11].weekStart).toBe(toKey(startOfWeek(new Date())))
  })

  it('准确率按题算，不是各篇得分的平均', async () => {
    const { token, dataKey } = await register()

    // 5 题全对（100 分）+ 10 题对 5（50 分）：平均分是 75，按题算是 10 / 15 = 67
    await makeReading(dataKey, {
      status: 'submitted',
      questions: questionsOf(5),
      questionCount: 5,
      correctCount: 5,
      submittedAt: new Date(),
    })
    await makeReading(dataKey, {
      status: 'submitted',
      questions: questionsOf(10),
      questionCount: 10,
      correctCount: 5,
      submittedAt: new Date(),
    })

    const res = await getStats(token)

    expect(res.body.questions).toEqual({ answered: 15, correct: 10, wrong: 5, accuracy: 67 })
    expect(res.body.reading.completedCount).toBe(2)
  })

  it('未提交的稿子计入篇数与 token，但不计入答题', async () => {
    const { token, dataKey } = await register()

    await makeReading(dataKey, {
      status: 'submitted',
      questions: questionsOf(3),
      questionCount: 3,
      correctCount: 2,
      submittedAt: new Date(),
      aiMeta: { totalTokens: 50 },
    })
    await makeReading(dataKey, {
      status: 'generated',
      questions: questionsOf(3),
      questionCount: 3,
      aiMeta: { totalTokens: 100 },
    })

    const res = await getStats(token)

    expect(res.body.reading).toEqual({ completedCount: 1, generatedCount: 2, totalTokens: 150 })
    expect(res.body.questions.answered).toBe(3)
    expect(res.body.questions.correct).toBe(2)
  })

  it('分母用 questions.length，不是用户请求的 questionCount', async () => {
    const { token, dataKey } = await register()

    // 用户要了 10 题，模型只给了 5 题：分母必须是 5，否则会出现「正确 5 / 10」但只有 5 题
    await makeReading(dataKey, {
      status: 'submitted',
      questions: questionsOf(5),
      questionCount: 10,
      correctCount: 5,
      submittedAt: new Date(),
    })

    const res = await getStats(token)

    expect(res.body.questions).toEqual({ answered: 5, correct: 5, wrong: 0, accuracy: 100 })
  })

  it('近 12 周分桶：本周 / 上周分开，窗口外的 12 周前不计入', async () => {
    const { token, dataKey } = await register()

    await makeReading(dataKey, { status: 'submitted', submittedAt: new Date(), questions: questionsOf(1), questionCount: 1, correctCount: 1 })
    await makeReading(dataKey, { status: 'submitted', submittedAt: weeksAgo(1), questions: questionsOf(1), questionCount: 1, correctCount: 1 })
    await makeReading(dataKey, { status: 'submitted', submittedAt: weeksAgo(1), questions: questionsOf(1), questionCount: 1, correctCount: 1 })
    await makeReading(dataKey, { status: 'submitted', submittedAt: weeksAgo(12), questions: questionsOf(1), questionCount: 1, correctCount: 1 })

    const res = await getStats(token)
    const weekly = res.body.weekly

    expect(weekly[11].count).toBe(1) // 本周
    expect(weekly[10].count).toBe(2) // 上周
    // 窗口外的篇目既不进柱子，也不影响其它格子
    expect(weekly.reduce((sum, item) => sum + item.count, 0)).toBe(3)
    // 但累计篇数（completedCount）统计的是全部历史
    expect(res.body.reading.completedCount).toBe(4)
  })

  it('分桶按 submittedAt：三周前生成、本周提交的算本周', async () => {
    const { token, dataKey } = await register()

    await makeReading(dataKey, {
      status: 'submitted',
      createdAt: weeksAgo(3),
      submittedAt: new Date(),
      questions: questionsOf(1),
      questionCount: 1,
      correctCount: 1,
    })

    const res = await getStats(token)

    expect(res.body.weekly[11].count).toBe(1) // 本周
    expect(res.body.weekly[8].count).toBe(0) // 三周前那一格
  })

  it('周一 0 点算本周，上周日 23:59:59 算上周', async () => {
    const { token, dataKey } = await register()
    const monday = startOfWeek(new Date())

    await makeReading(dataKey, { status: 'submitted', submittedAt: new Date(monday), questions: questionsOf(1), questionCount: 1, correctCount: 1 })
    await makeReading(dataKey, {
      status: 'submitted',
      submittedAt: new Date(monday.getTime() - 1000),
      questions: questionsOf(1),
      questionCount: 1,
      correctCount: 1,
    })

    const res = await getStats(token)

    expect(res.body.weekly[11].count).toBe(1)
    expect(res.body.weekly[10].count).toBe(1)
  })

  it('只统计自己的数据域', async () => {
    const mine = await register('StatsUser')
    const other = await register('OtherUser')

    await makeReading(other.dataKey, {
      status: 'submitted',
      submittedAt: new Date(),
      questions: questionsOf(4),
      questionCount: 4,
      correctCount: 1,
      aiMeta: { totalTokens: 999 },
    })

    const res = await getStats(mine.token)

    expect(res.body.reading).toEqual({ completedCount: 0, generatedCount: 0, totalTokens: 0 })
    expect(res.body.questions.answered).toBe(0)
    expect(res.body.weekly.every((item) => item.count === 0)).toBe(true)
  })
})
