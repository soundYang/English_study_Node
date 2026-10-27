import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { Reading } from '../modules/readings/reading.model.js'

const app = createApp()

const submit = (id, body) =>
  request(app).post(`/api/readings/${id}/submit`).send(body)

const QUESTIONS = [
  { id: 1, question: 'Q1?', options: ['a', 'b', 'c', 'd'], correctAnswer: 0, explanation: '解析1' },
  { id: 2, question: 'Q2?', options: ['a', 'b', 'c', 'd'], correctAnswer: 1, explanation: '解析2' },
  { id: 3, question: 'Q3?', options: ['a', 'b', 'c', 'd'], correctAnswer: 2, explanation: '解析3' },
]

function makeReading(overrides = {}) {
  return Reading.create({
    userId: config.defaultUserId,
    title: 'A Good Day',
    article: 'Tom is a good boy. His dog is big.',
    translation: '汤姆是个好男孩。他的狗很大。',
    level: 'easy',
    targetWords: 100,
    questionCount: 3,
    actualWords: 8,
    questions: QUESTIONS,
    vocabularySnapshot: ['tom', 'dog'],
    names: ['Tom'],
    status: 'generated',
    ...overrides,
  })
}

const answersOf = (...selected) =>
  QUESTIONS.map((question, index) => ({
    questionId: question.id,
    selectedOption: selected[index] ?? null,
  }))

beforeEach(() => {
  // 每个用例自己建文档，setup.js 的 afterEach 负责清库
})

describe('POST /api/readings/:id/submit · 判分', () => {
  it('全对 → 100 分', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, { answers: answersOf(0, 1, 2) })

    expect(res.status).toBe(200)
    expect(res.body.score).toBe(100)
    expect(res.body.accuracy).toBe(100)
    expect(res.body.correctCount).toBe(3)
    expect(res.body.totalQuestions).toBe(3)
    expect(res.body.status).toBe('submitted')
    expect(res.body.submittedAt).toBeTruthy()
  })

  it('全错 → 0 分', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, { answers: answersOf(3, 0, 0) })

    expect(res.status).toBe(200)
    expect(res.body.score).toBe(0)
    expect(res.body.correctCount).toBe(0)
  })

  it('部分对四舍五入：3 题对 2 → 67', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, { answers: answersOf(0, 1, 0) })

    expect(res.body.correctCount).toBe(2)
    expect(res.body.score).toBe(67)
  })

  it('selectedOption 为 null 判错，不报 400', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, { answers: answersOf(0, null, null) })

    expect(res.status).toBe(200)
    expect(res.body.score).toBe(33)
    expect(res.body.results[1]).toMatchObject({ selectedOption: null, isCorrect: false })
  })

  it('整题缺失也判错（防御性兼容，不是契约）', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, {
      answers: [{ questionId: 1, selectedOption: 0 }],
    })

    expect(res.status).toBe(200)
    expect(res.body.correctCount).toBe(1)
    expect(res.body.results.map((item) => item.selectedOption)).toEqual([0, null, null])
  })

  it('结果题目含 correctAnswer 与 explanation，供解析区渲染', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, { answers: answersOf(0, 0, 0) })

    expect(res.body.results[0]).toEqual({
      questionId: 1,
      selectedOption: 0,
      correctAnswer: 0,
      isCorrect: true,
      explanation: '解析1',
    })
    expect(res.body.translation).toContain('汤姆')
    expect(res.body.questions).toHaveLength(3)
    expect(res.body.questions[0]).not.toHaveProperty('correctAnswer')
  })

  it('响应不含 vocabularySnapshot / names / aiMeta', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, { answers: answersOf(0, 1, 2) })

    for (const forbidden of ['vocabularySnapshot', 'aiMeta', 'promptTokens']) {
      expect(res.text).not.toContain(forbidden)
    }
    expect(res.body).not.toHaveProperty('names')
  })

  it('提交不改 article / translation / questions', async () => {
    const reading = await makeReading()
    const before = {
      article: reading.article,
      translation: reading.translation,
      questions: reading.questions.map((question) => question.toObject()),
    }

    await submit(reading._id, { answers: answersOf(0, 1, 2) })

    const after = await Reading.findById(reading._id)
    expect(after.article).toBe(before.article)
    expect(after.translation).toBe(before.translation)
    expect(after.questions.map((question) => question.toObject())).toEqual(before.questions)
  })
})

describe('POST /api/readings/:id/submit · 幂等与并发', () => {
  it('重复提交 → 409 ALREADY_SUBMITTED', async () => {
    const reading = await makeReading()

    const first = await submit(reading._id, { answers: answersOf(0, 1, 2) })
    const second = await submit(reading._id, { answers: answersOf(0, 1, 2) })

    expect(first.status).toBe(200)
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('ALREADY_SUBMITTED')
  })

  it('并发两个请求：一个 200、一个 409', async () => {
    const reading = await makeReading()

    const [a, b] = await Promise.all([
      submit(reading._id, { answers: answersOf(0, 1, 2) }),
      submit(reading._id, { answers: answersOf(0, 1, 2) }),
    ])

    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  it('别人的练习 → 404', async () => {
    const reading = await makeReading({ userId: 'someone-else' })

    const res = await submit(reading._id, { answers: answersOf(0, 1, 2) })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('READING_NOT_FOUND')
  })

  it('不存在的 id → 404，非法 id → 404 而不是 500', async () => {
    const missing = await submit('507f1f77bcf86cd799439011', { answers: [] })
    const invalid = await submit('not-an-object-id', { answers: [] })

    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('READING_NOT_FOUND')
    expect(invalid.status).toBe(404)
    expect(invalid.body.error.code).toBe('READING_NOT_FOUND')
  })
})

describe('POST /api/readings/:id/submit · 输入校验', () => {
  it('answers 不是数组 → 400 INVALID_ANSWER', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, { answers: { 1: 2 } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_ANSWER')
  })

  it('questionId 不属于本练习 → 400 INVALID_ANSWER', async () => {
    const reading = await makeReading()

    const res = await submit(reading._id, {
      answers: [{ questionId: 9, selectedOption: 0 }],
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_ANSWER')
    expect(res.body.error.message).toContain('9')
  })

  it.each([4, -1, 1.5, '2'])('selectedOption 非法（%s）→ 400', async (value) => {
    const reading = await makeReading()

    const res = await submit(reading._id, {
      answers: [{ questionId: 1, selectedOption: value }],
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_ANSWER')
  })

  it('校验失败不写库，状态仍是 generated', async () => {
    const reading = await makeReading()

    await submit(reading._id, { answers: [{ questionId: 9, selectedOption: 0 }] })

    const after = await Reading.findById(reading._id)
    expect(after.status).toBe('generated')
    expect(after.score).toBeNull()
  })
})
