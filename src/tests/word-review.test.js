import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { deriveStudyState } from '../modules/words/word.dto.js'
import { Word } from '../modules/words/word.model.js'
import {
  DAILY_REVIEW_LIMIT,
  MASTER_STAGE,
} from '../modules/words/review-schedule.js'

const app = createApp()
const uid = config.defaultUserId

const DAY_MS = 24 * 60 * 60 * 1000

const seed = (docs) =>
  Word.insertMany(docs.map((doc) => ({ userId: uid, source: 'manual', ...doc })))

const dailyPlan = () => request(app).get('/api/words/daily-plan')
const review = (id, result) =>
  request(app).post(`/api/words/${id}/review`).send({ result })

/**
 * 改历史时间必须走原生 collection：走 Mongoose 时 `timestamps` 会把
 * createdAt 覆盖回当前时间，settlement 的「过夜」判定就永远不成立。
 */
function setCreatedAt(word, daysAgo) {
  return Word.collection.updateOne(
    { userId: uid, word },
    { $set: { createdAt: new Date(Date.now() - daysAgo * DAY_MS) } },
  )
}

function setNextReviewAt(word, daysAgo) {
  return Word.collection.updateOne(
    { userId: uid, word },
    { $set: { nextReviewAt: new Date(Date.now() - daysAgo * DAY_MS) } },
  )
}

const findWord = (word) => Word.findOne({ userId: uid, word })

describe('GET /api/words/daily-plan', () => {
  it('空库返回齐全的结构', async () => {
    const res = await dailyPlan()

    expect(res.status).toBe(200)
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(res.body.newWords.addedToday).toBe(0)
    expect(res.body.review.remaining).toBe(0)
    expect(res.body.review.words).toEqual([])
  })

  it('过夜的 new 词第二天变成 learning 并进入复习队列', async () => {
    await seed([{ word: 'alpha', status: 'new' }])
    await setCreatedAt('alpha', 2)

    const res = await dailyPlan()

    expect(res.status).toBe(200)
    expect(res.body.review.words.map((item) => item.word)).toContain('alpha')

    const doc = await findWord('alpha')
    expect(doc.status).toBe('learning')
    expect(doc.nextReviewAt).not.toBeNull()
  })

  it('今天新加的词不进今天的队列，排到明天', async () => {
    await seed([{ word: 'beta' }])

    const res = await dailyPlan()

    expect(res.body.review.words.map((item) => item.word)).not.toContain('beta')

    const doc = await findWord('beta')
    expect(doc.nextReviewAt).not.toBeNull()
    // 排期 = 加入日的次日，所以一定晚于现在
    expect(doc.nextReviewAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('基础词墓碑不参与结算，也不会进队列', async () => {
    await seed([{ word: 'gamma', status: 'new', source: 'basic-removed' }])
    await setCreatedAt('gamma', 3)

    const res = await dailyPlan()

    expect(res.body.review.words.map((item) => item.word)).not.toContain('gamma')

    const doc = await findWord('gamma')
    expect(doc.status).toBe('new')
    expect(doc.nextReviewAt).toBeNull()
  })

  it('addedToday 不含基础词墓碑', async () => {
    await seed([
      { word: 'delta' },
      { word: 'epsilon', status: 'new', source: 'basic-removed' },
    ])

    const res = await dailyPlan()

    expect(res.body.newWords.addedToday).toBe(1)
  })

  it('积压超过上限时只带回上限条数，remaining 仍是全量', async () => {
    const total = DAILY_REVIEW_LIMIT + 10
    const docs = Array.from({ length: total }, (_, i) => ({
      word: `bulk${i}`,
      nextReviewAt: new Date(Date.now() - DAY_MS),
    }))

    await seed(docs)

    const res = await dailyPlan()

    expect(res.body.review.remaining).toBe(total)
    expect(res.body.review.today).toBe(DAILY_REVIEW_LIMIT)
    expect(res.body.review.words).toHaveLength(DAILY_REVIEW_LIMIT)
  })

  it('多条 GET /api/words 也不会重复结算', async () => {
    await seed([{ word: 'zeta' }])

    await request(app).get('/api/words').query({ q: '', status: 'all', page: 1, pageSize: 10 })
    const first = (await findWord('zeta')).nextReviewAt

    await request(app).get('/api/words').query({ q: '', status: 'all', page: 1, pageSize: 10 })
    const second = (await findWord('zeta')).nextReviewAt

    expect(second.getTime()).toBe(first.getTime())
  })
})

describe('POST /api/words/:id/review', () => {
  it('通过一轮：轮次 +1，留学习状态，排下次复习', async () => {
    const [doc] = await seed([{ word: 'pass1' }])
    await setNextReviewAt('pass1', 1)

    const res = await review(doc._id, 'pass')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('learning')
    expect(res.body.reviewStage).toBe(1)
    expect(res.body.lastReviewedAt).not.toBeNull()
    expect(new Date(res.body.nextReviewAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('达到掌握门槛：转 mastered 并退出复习队列', async () => {
    const [doc] = await seed([{ word: 'pass2', reviewStage: MASTER_STAGE - 1 }])
    await setNextReviewAt('pass2', 1)

    const res = await review(doc._id, 'pass')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('mastered')
    expect(res.body.nextReviewAt).toBeNull()

    const saved = await findWord('pass2')
    expect(saved.masteredAt).not.toBeNull()
  })

  it('没记住：轮次归零、计数 +1、明天再来', async () => {
    const [doc] = await seed([{ word: 'lapse1', reviewStage: 1, lapseCount: 2 }])
    await setNextReviewAt('lapse1', 1)

    const res = await review(doc._id, 'lapse')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('learning')
    expect(res.body.reviewStage).toBe(0)
    expect(res.body.lapseCount).toBe(3)
    // 排到明天零点之后
    expect(new Date(res.body.nextReviewAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('result 非法直接 400，不做兜底', async () => {
    const [doc] = await seed([{ word: 'bad1' }])

    const res = await review(doc._id, 'maybe')

    expect(res.status).toBe(400)
  })

  it('不存在的词返回 404', async () => {
    const res = await review('66f000000000000000000000', 'pass')

    expect(res.status).toBe(404)
  })

  it('非法 ObjectId 也按 404 处理，不掉到 500', async () => {
    const res = await review('not-an-id', 'pass')

    expect(res.status).toBe(404)
  })

  it('基础词墓碑不能自评', async () => {
    const [doc] = await seed([{ word: 'tomb', status: 'new', source: 'basic-removed' }])

    const res = await review(doc._id, 'pass')

    expect(res.status).toBe(400)
  })
})

describe('studyState 派生字段（md/56 §14.4 方案 B）', () => {
  it('今天加入的词显示为「新词」', async () => {
    await seed([{ word: 'fresh' }])

    const res = await request(app)
      .get('/api/words')
      .query({ q: 'fresh', status: 'all', page: 1, pageSize: 10 })

    expect(res.body.items[0].studyState).toBe('new')
  })

  it('过夜后变成「复习中」，不需要前端参与', async () => {
    await seed([{ word: 'aging' }])
    await setCreatedAt('aging', 2)

    const res = await request(app)
      .get('/api/words')
      .query({ q: 'aging', status: 'all', page: 1, pageSize: 10 })

    expect(res.body.items[0].studyState).toBe('reviewing')
  })

  it('已掌握优先于「今天加入」', async () => {
    await seed([{ word: 'todaydone', status: 'mastered' }])

    const res = await request(app)
      .get('/api/words')
      .query({ q: 'todaydone', status: 'all', page: 1, pageSize: 10 })

    expect(res.body.items[0].studyState).toBe('mastered')
  })

  it('基础词墓碑单独一档，不会跟「新词」混淆', async () => {
    await seed([{ word: 'gone', status: 'new', source: 'basic-removed' }])

    // 墓碑默认不进列表（md/22 第 95 行 ③），要看就 study=removed
    const hidden = await request(app)
      .get('/api/words')
      .query({ q: 'gone', status: 'all', page: 1, pageSize: 10 })

    expect(hidden.body.items).toHaveLength(0)

    const res = await request(app)
      .get('/api/words')
      .query({ q: 'gone', study: 'removed', page: 1, pageSize: 10 })

    expect(res.body.items[0].studyState).toBe('removed')
  })

  it('跨零点即切换，不用等满 24 小时', () => {
    // 昨天 23:50 加入的词，今早 00:10 就该是「复习中」
    const now = new Date(2026, 10, 2, 0, 10)
    const addedLateLastNight = new Date(2026, 10, 1, 23, 50)

    expect(deriveStudyState({ status: 'learning', createdAt: addedLateLastNight }, now))
      .toBe('reviewing')
    expect(deriveStudyState({ status: 'learning', createdAt: new Date(2026, 10, 2, 9, 0) }, now))
      .toBe('new')
  })

  it('createdAt 缺失时按老词处理，不凭空造出「新词」', () => {
    expect(deriveStudyState({ status: 'learning' })).toBe('reviewing')
  })
})

describe('手动改状态时维护排期', () => {
  it('手动设为 mastered：退出队列并记掌握时刻', async () => {
    const [doc] = await seed([{ word: 'manual1' }])

    const res = await request(app).patch(`/api/words/${doc._id}`).send({ status: 'mastered' })

    expect(res.status).toBe(200)

    const saved = await findWord('manual1')
    expect(saved.nextReviewAt).toBeNull()
    expect(saved.masteredAt).not.toBeNull()
  })

  it('手动设回 learning：今天立刻进队列', async () => {
    const [doc] = await seed([{ word: 'manual2', status: 'mastered' }])

    await request(app).patch(`/api/words/${doc._id}`).send({ status: 'learning' })

    const saved = await findWord('manual2')
    expect(saved.nextReviewAt).not.toBeNull()
    expect(saved.nextReviewAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(saved.masteredAt).toBeNull()
  })

  it('手动设成 new：退出队列，等次日结算', async () => {
    const [doc] = await seed([{ word: 'manual3' }])

    await request(app).patch(`/api/words/${doc._id}`).send({ status: 'new' })

    const saved = await findWord('manual3')
    expect(saved.nextReviewAt).toBeNull()
  })
})
