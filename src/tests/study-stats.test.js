import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { localDateKey } from '../modules/words/review-schedule.js'
import { StudyDay } from '../modules/words/study-day.model.js'
import { Word } from '../modules/words/word.model.js'
import { computeStreak } from '../modules/words/study-stats.service.js'

const app = createApp()
const uid = config.defaultUserId

const DAY_MS = 24 * 60 * 60 * 1000
const stats = () => request(app).get('/api/words/stats')
const review = (id, result) => request(app).post(`/api/words/${id}/review`).send({ result })
const reviewBatch = (items) => request(app).post('/api/words/review/batch').send({ items })

const seedWord = (doc) =>
  Word.create({
    userId: uid,
    status: 'learning',
    source: 'manual',
    senses: [{ pos: '', meaning: '测试释义' }],
    ...doc,
  })

/** 往前推 n 天的本地日期键 */
const dayKey = (daysAgo) => localDateKey(new Date(Date.now() - daysAgo * DAY_MS))

describe('computeStreak', () => {
  const now = new Date(2026, 10, 15, 10, 0)

  it('今天有记录就从今天往回数', () => {
    expect(computeStreak(['2026-11-15', '2026-11-14', '2026-11-13'], now)).toBe(3)
  })

  it('今天还没复习不算断，从昨天往回数', () => {
    expect(computeStreak(['2026-11-14', '2026-11-13'], now)).toBe(2)
  })

  it('中间断了一天就停在那里', () => {
    expect(computeStreak(['2026-11-15', '2026-11-13', '2026-11-12'], now)).toBe(1)
  })

  it('完全没有记录是 0', () => {
    expect(computeStreak([], now)).toBe(0)
  })

  it('昨天也没记录就是 0，不会跳到前天', () => {
    expect(computeStreak(['2026-11-13'], now)).toBe(0)
  })
})

describe('GET /api/words/stats', () => {
  it('空库返回齐全的结构，热力图补满 30 天', async () => {
    const res = await stats()

    expect(res.status).toBe(200)
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(res.body.streak).toBe(0)
    expect(res.body.today).toEqual({ reviewed: 0, mastered: 0 })
    expect(res.body.total).toEqual({ reviewed: 0, mastered: 0 })
    expect(res.body.mastery).toEqual({ count: 0, avgStage: 0 })
    expect(res.body.pendingReview).toBe(0)
    expect(res.body.heatmap).toHaveLength(30)
    expect(res.body.heatmap.at(-1).date).toBe(res.body.date)
  })

  it('单次自评记进当天流水', async () => {
    const doc = await seedWord({ word: 'solo' })

    await review(doc._id, 'pass')

    const res = await stats()
    expect(res.body.today.reviewed).toBe(1)
    expect(res.body.today.mastered).toBe(0)
  })

  it('通过到掌握线时同时记 mastered', async () => {
    const doc = await seedWord({ word: 'finish', reviewStage: 1 })

    await review(doc._id, 'pass')

    const res = await stats()
    expect(res.body.today.reviewed).toBe(1)
    expect(res.body.today.mastered).toBe(1)
    expect(res.body.mastery).toEqual({ count: 1, avgStage: 2 })
  })

  it('「没记住」不算 mastered', async () => {
    const doc = await seedWord({ word: 'oops', reviewStage: 1 })

    await review(doc._id, 'lapse')

    const res = await stats()
    expect(res.body.today.reviewed).toBe(1)
    expect(res.body.today.mastered).toBe(0)
  })

  it('批量自评按条数累加', async () => {
    const a = await seedWord({ word: 'b1' })
    const b = await seedWord({ word: 'b2', reviewStage: 1 })

    await reviewBatch([
      { id: String(a._id), result: 'pass' },
      { id: String(b._id), result: 'pass' },
    ])

    const res = await stats()
    expect(res.body.today.reviewed).toBe(2)
    expect(res.body.today.mastered).toBe(1)
  })

  it('同一天多次自评累加，不是覆盖', async () => {
    const doc = await seedWord({ word: 'again' })

    await review(doc._id, 'pass')
    await review(doc._id, 'pass')

    const res = await stats()
    expect(res.body.today.reviewed).toBe(2)
  })

  it('连续天数按流水算，昨天有今天没有也照样算', async () => {
    await StudyDay.insertMany([
      { userId: uid, date: dayKey(1), reviewed: 3, mastered: 0 },
      { userId: uid, date: dayKey(2), reviewed: 2, mastered: 1 },
      { userId: uid, date: dayKey(3), reviewed: 1, mastered: 0 },
      // 更早的那天故意留空，连续天数必须停在前一天
      { userId: uid, date: dayKey(5), reviewed: 9, mastered: 0 },
    ])

    const res = await stats()
    expect(res.body.streak).toBe(3)
    expect(res.body.total).toEqual({ reviewed: 15, mastered: 1 })
  })

  it('reviewed 为 0 的一天不算活动，会断开连续', async () => {
    await StudyDay.insertMany([
      { userId: uid, date: dayKey(1), reviewed: 3, mastered: 0 },
      { userId: uid, date: dayKey(2), reviewed: 0, mastered: 0 },
      { userId: uid, date: dayKey(3), reviewed: 4, mastered: 0 },
    ])

    const res = await stats()
    expect(res.body.streak).toBe(1)
  })

  it('热力图把流水填到对应日期，没有记录的日子是 0', async () => {
    await StudyDay.create({ userId: uid, date: dayKey(2), reviewed: 5, mastered: 1 })

    const res = await stats()
    const row = res.body.heatmap.find((item) => item.date === dayKey(2))

    expect(row).toEqual({ date: dayKey(2), reviewed: 5, mastered: 1 })
    expect(res.body.heatmap.find((item) => item.date === dayKey(1)).reviewed).toBe(0)
  })

  it('pendingReview 统计到期词，基础词墓碑不算', async () => {
    await seedWord({ word: 'due', nextReviewAt: new Date(Date.now() - DAY_MS) })
    await seedWord({
      word: 'tomb',
      status: 'new',
      source: 'basic-removed',
      nextReviewAt: new Date(Date.now() - DAY_MS),
    })

    const res = await stats()
    expect(res.body.pendingReview).toBe(1)
  })

  it('平均掌握轮次保留一位小数', async () => {
    await seedWord({ word: 'm1', status: 'mastered', reviewStage: 2 })
    await seedWord({ word: 'm2', status: 'mastered', reviewStage: 3 })
    await seedWord({ word: 'm3', status: 'mastered', reviewStage: 3 })

    const res = await stats()
    // (2 + 3 + 3) / 3 = 2.666… → 2.7
    expect(res.body.mastery).toEqual({ count: 3, avgStage: 2.7 })
  })
})
