import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { Reading } from '../modules/readings/reading.model.js'

const app = createApp()

// W7：type 进安全 DTO，evidence 只进结果页的 results[]
const QUESTIONS = [
  { id: 1, question: 'Q1?', type: 'detail', evidence: 'Tom is a good boy.', options: ['a', 'b', 'c', 'd'], correctAnswer: 0, explanation: '解析1' },
  { id: 2, question: 'Q2?', type: 'detail', evidence: 'His dog is big.', options: ['a', 'b', 'c', 'd'], correctAnswer: 1, explanation: '解析2' },
  { id: 3, question: 'Q3?', type: 'inference', evidence: 'Tom is a good boy.', options: ['a', 'b', 'c', 'd'], correctAnswer: 2, explanation: '解析3' },
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
    actualWords: 40,
    questions: QUESTIONS,
    vocabularySnapshot: ['tom', 'dog'],
    names: ['Tom'],
    status: 'generated',
    ...overrides,
  })
}

/** 已提交的练习：库里的 score 是提交时算好的，这里直接给 */
function makeSubmitted({ score = 100, correctCount = 3, level = 'easy', words = 40, ...rest } = {}) {
  return makeReading({
    level,
    actualWords: words,
    status: 'submitted',
    score,
    correctCount,
    submittedAt: new Date(),
    userAnswers: { 1: 0, 2: 1, 3: 2 },
    ...rest,
  })
}

const detail = (id) => request(app).get(`/api/readings/${id}`)
const history = (query) => request(app).get('/api/readings/history').query(query)

describe('GET /api/readings/:id · 未提交分支', () => {
  it('返回安全 DTO：恰好 13 个字段，不含翻译与答案', async () => {
    const reading = await makeReading()

    const res = await detail(reading._id)

    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual([
      'actualWords',
      'article',
      'createdAt',
      'focusWords',
      'id',
      'level',
      'newWords',
      'questionCount',
      'questions',
      'status',
      'targetWords',
      'title',
      'tokenUsage',
      // md/56 §6.3：本篇实际用到的用户词
      'usedWords',
    ])
    expect(res.body.status).toBe('generated')
    expect(res.body.questions).toHaveLength(3)
    // type 是给答题页的题型标签；evidence 不在这里——它就是答案所在的句子
    expect(Object.keys(res.body.questions[0]).sort()).toEqual([
      'id',
      'options',
      'question',
      'type',
    ])
    expect(res.text).not.toContain('correctAnswer')
    expect(res.text).not.toContain('translation')
    expect(res.text).not.toContain('explanation')
  })
})

describe('GET /api/readings/:id · 已提交分支', () => {
  it('带翻译、成绩与逐题解析，题目本身仍在', async () => {
    const reading = await makeSubmitted({ score: 67, correctCount: 2 })

    const res = await detail(reading._id)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('submitted')
    expect(res.body.translation).toContain('汤姆')
    expect(res.body.score).toBe(67)
    expect(res.body.accuracy).toBe(67)
    expect(res.body.correctCount).toBe(2)
    expect(res.body.totalQuestions).toBe(3)
    expect(res.body.submittedAt).toBeTruthy()
    expect(res.body.questions).toHaveLength(3)
    expect(res.body.results).toHaveLength(3)
    expect(res.body.results[0]).toEqual({
      questionId: 1,
      selectedOption: 0,
      correctAnswer: 0,
      isCorrect: true,
      explanation: '解析1',
      // W7：原文依据只在答题后给
      evidence: 'Tom is a good boy.',
    })
  })

  it('不返回 vocabularySnapshot / names / aiMeta', async () => {
    const reading = await makeSubmitted()

    const res = await detail(reading._id)

    expect(res.body).not.toHaveProperty('names')
    expect(res.text).not.toContain('vocabularySnapshot')
    expect(res.text).not.toContain('aiMeta')
  })

  it('返回逐段翻译，下标与正文段落一一对应', async () => {
    const reading = await makeSubmitted({
      article: 'Tom is a good boy.\n\nHis dog is big.',
      translation: '汤姆是个好男孩。\n\n他的狗很大。',
      translations: ['汤姆是个好男孩。', '他的狗很大。'],
    })

    const res = await detail(reading._id)

    expect(res.body.translations).toEqual(['汤姆是个好男孩。', '他的狗很大。'])
    // 整篇翻译继续保留，老前端不受影响
    expect(res.body.translation).toContain('汤姆')
  })

  it('老文档没有 translations 时，整篇翻译按空行回退拆段', async () => {
    const reading = await makeSubmitted({
      article: 'Tom is a good boy.\n\nHis dog is big.',
      translation: '汤姆是个好男孩。\n\n他的狗很大。',
    })

    const res = await detail(reading._id)

    expect(res.body.translations).toEqual(['汤姆是个好男孩。', '他的狗很大。'])
  })

  it('翻译与正文段数对不上时回空数组，不硬拆句子', async () => {
    const reading = await makeSubmitted({
      article: 'Tom is a good boy.\n\nHis dog is big.',
      translation: '汤姆是个好男孩，他的狗很大。',
    })

    const res = await detail(reading._id)

    expect(res.body.translations).toEqual([])
    expect(res.body.translation).toContain('汤姆')
  })
})

describe('GET /api/readings/:id · 404', () => {
  it('不存在的 id、非法 id、别人的记录都是 404 READING_NOT_FOUND', async () => {
    const other = await makeReading({ userId: 'someone-else' })

    for (const id of ['507f1f77bcf86cd799439011', 'not-an-object-id', String(other._id)]) {
      const res = await detail(id)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('READING_NOT_FOUND')
    }
  })
})

describe('GET /api/readings/history · 统计口径', () => {
  it('level 筛选改变 total 与 items，但 stats 纹丝不动', async () => {
    await makeSubmitted({ score: 100, words: 100 })
    await makeSubmitted({ score: 50, words: 200 })
    await makeSubmitted({ score: 75, words: 300, level: 'hard' })

    const all = await history({ level: 'all' })
    const easy = await history({ level: 'easy' })

    expect(all.status).toBe(200)
    expect(all.body.total).toBe(3)
    expect(easy.body.total).toBe(2)
    expect(easy.body.items.every((item) => item.level === 'easy')).toBe(true)
    expect(easy.body.stats).toEqual(all.body.stats)
  })

  it('stats 只统计已提交记录；未提交不计入', async () => {
    await makeSubmitted({ score: 100, words: 40 })
    await makeReading() // 未提交

    const res = await history({ level: 'all' })

    expect(res.body.total).toBe(2) // 列表里两条都在
    expect(res.body.stats).toEqual({
      totalCount: 1,
      averageAccuracy: 100,
      bestScore: 100,
      totalWordsRead: 40,
    })
  })

  it('平均分四舍五入、最高分取最大、词数累加 actualWords', async () => {
    await makeSubmitted({ score: 100, words: 10 })
    await makeSubmitted({ score: 50, words: 20 })
    await makeSubmitted({ score: 75, words: 30 })

    const res = await history({ level: 'all' })

    expect(res.body.stats).toEqual({
      totalCount: 3,
      averageAccuracy: 75, // (100+50+75)/3 = 75
      bestScore: 100,
      totalWordsRead: 60,
    })
  })

  it('空数据时 stats 全是 0，不是 null', async () => {
    const res = await history({ level: 'all' })

    expect(res.body.total).toBe(0)
    expect(res.body.items).toEqual([])
    expect(res.body.stats).toEqual({
      totalCount: 0,
      averageAccuracy: 0,
      bestScore: 0,
      totalWordsRead: 0,
    })
  })

  it('别人家的记录完全不可见', async () => {
    await makeSubmitted({ userId: 'someone-else', score: 100 })

    const res = await history({ level: 'all' })

    expect(res.body.total).toBe(0)
    expect(res.body.stats.totalCount).toBe(0)
  })
})

describe('GET /api/readings/history · 列表', () => {
  it('未提交条目 score / accuracy / submittedAt 都是 null', async () => {
    await makeReading()

    const res = await history({ level: 'all' })

    expect(res.body.items[0]).toMatchObject({
      status: 'generated',
      score: null,
      accuracy: null,
      submittedAt: null,
    })
  })

  it('条目字段与前端历史表一致', async () => {
    await makeSubmitted({ score: 67 })

    const res = await history({ level: 'all' })

    expect(Object.keys(res.body.items[0]).sort()).toEqual([
      'accuracy',
      'createdAt',
      'id',
      'level',
      'questionCount',
      'score',
      'status',
      'submittedAt',
      'title',
      'tokenUsage',
    ])
    expect(res.body.items[0].accuracy).toBe(res.body.items[0].score)
  })

  it('默认按创建时间倒序，最新在前', async () => {
    await makeReading({ title: 'older' })
    await makeReading({ title: 'newer' })

    const res = await history({ level: 'all' })

    expect(res.body.items.map((item) => item.title)).toEqual(['newer', 'older'])
  })

  it('分页：pageSize 生效，页码越界收敛到最后一页', async () => {
    for (let i = 0; i < 5; i += 1) await makeReading({ title: `r${i}` })

    const first = await history({ level: 'all', page: 1, pageSize: 2 })
    expect(first.body.page).toBe(1)
    expect(first.body.total).toBe(5)
    expect(first.body.items).toHaveLength(2)

    const last = await history({ level: 'all', page: 99, pageSize: 2 })
    expect(last.body.page).toBe(3)
    expect(last.body.items).toHaveLength(1)
  })

  it('未知 level 按不筛选处理；_t 时间戳不影响解析', async () => {
    await makeSubmitted({ level: 'hard' })

    const res = await history({ level: 'evil', page: 1, pageSize: 10, _t: '123' })

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
  })

  it('page 非法 → 400', async () => {
    const res = await history({ page: 0 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.field).toBe('page')
  })
})
