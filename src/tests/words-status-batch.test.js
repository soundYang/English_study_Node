import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { BasicWordMark } from '../modules/basic-words/basic-word-mark.model.js'
import { basicWordCatalog } from '../modules/basic-words/basic-words.catalog.js'
import { startOfLocalDay } from '../shared/utils/time.js'
import { Word } from '../modules/words/word.model.js'
import { wordRepository } from '../modules/words/word.repository.js'

/**
 * 批量改学习状态（md/61）。
 *
 * 重点不是「接口通不通」，而是：
 *   1. 五个 target 的迁移矩阵每一行都对；
 *   2. 单项失败不拖垮整批；
 *   3. dryRun 不写库，且预览的 studyState 与真实执行一致；
 *   4. 与单条 PATCH 共用同一份排期副作用。
 */
const app = createApp()
const uid = config.defaultUserId
const DAY_MS = 24 * 60 * 60 * 1000

const batchStatus = (body) => request(app).post('/api/words/status/batch').send(body)
const list = (query) => request(app).get('/api/words').query(query)
const findWord = (word) => Word.findOne({ userId: uid, word })

async function seed(docs) {
  return Word.create(docs.map((doc) => ({ userId: uid, source: 'manual', ...doc })))
}

/** 改历史时间必须走原生 collection，否则 timestamps 会把 createdAt 覆盖回现在 */
function setCreatedAt(word, daysAgo) {
  return Word.collection.updateOne(
    { userId: uid, word },
    { $set: { createdAt: new Date(Date.now() - daysAgo * DAY_MS) } },
  )
}

function sameLocalDay(value) {
  if (!value) return false
  return new Date(value).getTime() === startOfLocalDay(new Date()).getTime()
}

const functionWord = basicWordCatalog.find((entry) => entry.isFunctionWord)
const readonlyWord = basicWordCatalog.find(
  (entry) => !entry.isFunctionWord && !entry.removable,
)
const removableWord = basicWordCatalog.find((entry) => entry.removable)

describe('POST /api/words/status/batch · 迁移', () => {
  it('learning → mastered：退出队列并记下掌握时刻', async () => {
    const [doc] = await seed([
      {
        word: 'alpha',
        status: 'learning',
        reviewStage: 1,
        nextReviewAt: new Date(),
      },
    ])

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'mastered',
    })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      target: 'mastered',
      dryRun: false,
      requested: 1,
      updated: 1,
      unchanged: 0,
      skipped: [],
    })
    expect(res.body.words[0]).toMatchObject({
      word: 'alpha',
      status: 'mastered',
      studyState: 'mastered',
    })
    expect(res.body.studyCounts.mastered).toBe(1)

    const updated = await findWord('alpha')
    expect(updated.status).toBe('mastered')
    expect(updated.nextReviewAt).toBeNull()
    expect(updated.masteredAt).toBeTruthy()
  })

  it('mastered → learning：保留轮次，排到今天，清掉掌握时刻', async () => {
    const [doc] = await seed([
      {
        word: 'beta',
        status: 'mastered',
        reviewStage: 2,
        masteredAt: new Date(),
      },
    ])

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'learning',
    })

    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(1)

    const updated = await findWord('beta')
    expect(updated.status).toBe('learning')
    expect(updated.reviewStage).toBe(2)
    expect(updated.masteredAt).toBeNull()
    expect(sameLocalDay(updated.nextReviewAt)).toBe(true)
  })

  it('今天创建 → new 成功；老词 → NEW_STATE_ONLY_TODAY', async () => {
    const [fresh] = await seed([{ word: 'fresh', status: 'learning' }])
    const [old] = await seed([{ word: 'oldie', status: 'learning' }])
    await setCreatedAt('oldie', 2)

    const freshRes = await batchStatus({
      ids: [String(fresh._id)],
      target: 'new',
    })
    expect(freshRes.body.updated).toBe(1)
    expect((await findWord('fresh')).status).toBe('new')

    const oldRes = await batchStatus({
      ids: [String(old._id)],
      target: 'new',
    })
    expect(oldRes.body.updated).toBe(0)
    expect(oldRes.body.skipped).toEqual([
      {
        id: String(old._id),
        word: 'oldie',
        reason: 'NEW_STATE_ONLY_TODAY',
      },
    ])
    expect((await findWord('oldie')).status).toBe('learning')
  })

  it('今天的新词改成 learning：写库成功，但 studyState 今天仍是 new', async () => {
    const [doc] = await seed([{ word: 'todayword', status: 'new' }])

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'learning',
    })

    expect(res.body.updated).toBe(1)
    expect(res.body.words[0]).toMatchObject({
      status: 'learning',
      studyState: 'new',
    })

    const updated = await findWord('todayword')
    expect(updated.status).toBe('learning')
    expect(sameLocalDay(updated.nextReviewAt)).toBe(true)
  })

  it('普通词 → removed：软移除，默认列表隐藏，study=removed 能查到，候选池排除', async () => {
    const [doc] = await seed([
      { word: 'epsilon', status: 'learning', reviewStage: 1 },
    ])

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'removed',
    })

    expect(res.body.updated).toBe(1)

    const removed = await findWord('epsilon')
    expect(removed).toMatchObject({
      source: 'basic-removed',
      status: 'new',
      reviewStage: 1,
    })
    expect(removed.nextReviewAt).toBeNull()

    const defaultList = await list({ q: '', status: 'all', page: 1, pageSize: 10 })
    expect(defaultList.body.items.map((item) => item.word)).not.toContain('epsilon')
    expect(defaultList.body.studyCounts).toMatchObject({ removed: 1 })

    const removedList = await list({
      q: '',
      status: 'all',
      study: 'removed',
      page: 1,
      pageSize: 10,
    })
    expect(removedList.body.items.map((item) => item.word)).toContain('epsilon')

    const vocabulary = await wordRepository.findVocabulary(uid)
    expect(vocabulary.map((item) => item.word)).not.toContain('epsilon')
  })

  it('功能词 / 日历词 / 缩写不能 removed，个人词可以', async () => {
    const [fw] = await seed([{ word: functionWord.word, status: 'learning' }])
    const [ro] = await seed([{ word: readonlyWord.word, status: 'learning' }])
    const [personal] = await seed([{ word: 'myownword', status: 'learning' }])

    const res = await batchStatus({
      ids: [String(fw._id), String(ro._id), String(personal._id)],
      target: 'removed',
    })

    expect(res.body.updated).toBe(1)
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        {
          id: String(fw._id),
          word: functionWord.word,
          reason: 'FUNCTION_WORD_IMMUTABLE',
        },
        {
          id: String(ro._id),
          word: readonlyWord.word,
          reason: 'BASIC_WORD_READONLY',
        },
      ]),
    )
    expect((await findWord('myownword')).source).toBe('basic-removed')
  })

  it('墓碑不能直接改成 learning / mastered / new', async () => {
    const [doc] = await seed([
      { word: 'gamma', status: 'new', source: 'basic-removed' },
    ])

    for (const target of ['new', 'learning', 'mastered']) {
      const res = await batchStatus({
        ids: [String(doc._id)],
        target,
      })

      expect(res.body.updated).toBe(0)
      expect(res.body.skipped[0]).toMatchObject({
        id: String(doc._id),
        reason: 'BASIC_REMOVED',
      })
    }
  })

  it('墓碑 → restore：回到 learning，轮次归零，排到今天', async () => {
    const [doc] = await seed([
      {
        word: 'abandon',
        status: 'new',
        source: 'basic-removed',
        reviewStage: 2,
        senses: [{ pos: 'vt.', meaning: '放弃' }],
      },
    ])

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'restore',
    })

    expect(res.body.updated).toBe(1)

    const restored = await findWord('abandon')
    expect(restored.source).toBe('dictionary')
    expect(restored.status).toBe('learning')
    expect(restored.reviewStage).toBe(0)
    expect(restored.masteredAt).toBeNull()
    expect(sameLocalDay(restored.nextReviewAt)).toBe(true)
  })

  it('手写释义的墓碑恢复为 manual', async () => {
    const [doc] = await seed([
      {
        word: 'abandon',
        status: 'new',
        source: 'basic-removed',
        senses: [{ pos: '', meaning: '我的记法' }],
      },
    ])

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'restore',
    })

    expect(res.body.updated).toBe(1)
    expect((await findWord('abandon')).source).toBe('manual')
  })

  it('非墓碑 → restore 是幂等空操作', async () => {
    const [doc] = await seed([{ word: 'delta', status: 'learning' }])

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'restore',
    })

    expect(res.body).toMatchObject({ updated: 0, unchanged: 1, skipped: [] })
  })

  it('连续执行两次是幂等的', async () => {
    const [doc] = await seed([{ word: 'idem', status: 'learning' }])
    const body = { ids: [String(doc._id)], target: 'mastered' }

    expect((await batchStatus(body)).body.updated).toBe(1)

    const second = await batchStatus(body)
    expect(second.body).toMatchObject({
      updated: 0,
      unchanged: 1,
      skipped: [],
    })
  })
})

describe('POST /api/words/status/batch · 批量语义', () => {
  it('非法 id / 别人的 id 进 skipped，不影响同批其他词', async () => {
    const [mine] = await seed([{ word: 'mine', status: 'learning' }])
    const other = await Word.create({
      userId: 'someone-else',
      word: 'theirs',
      status: 'learning',
      source: 'manual',
    })

    const res = await batchStatus({
      ids: ['not-an-object-id', String(other._id), String(mine._id)],
      target: 'mastered',
    })

    expect(res.body.requested).toBe(3)
    expect(res.body.updated).toBe(1)
    expect(res.body.skipped).toEqual([
      { id: 'not-an-object-id', reason: 'NOT_FOUND' },
      { id: String(other._id), reason: 'NOT_FOUND' },
    ])
    expect((await findWord('mine')).status).toBe('mastered')
    expect(
      await Word.findById(other._id).then((doc) => doc.status),
    ).toBe('learning')
  })

  it('重复 id 去重后只处理一次', async () => {
    const [doc] = await seed([{ word: 'dupe', status: 'learning' }])
    const id = String(doc._id)

    const res = await batchStatus({
      ids: [id, id, id],
      target: 'mastered',
    })

    expect(res.body.requested).toBe(1)
    expect(res.body.updated).toBe(1)
  })

  it('dryRun 不写库，预览的 toStudyState 与真实执行一致', async () => {
    const [doc] = await seed([{ word: 'preview', status: 'learning' }])
    await setCreatedAt('preview', 2)

    const preview = await batchStatus({
      ids: [String(doc._id)],
      target: 'mastered',
      dryRun: true,
    })

    expect(preview.body).toMatchObject({
      dryRun: true,
      updated: 1,
      unchanged: 0,
      skipped: [],
    })
    expect(preview.body.plan[0]).toMatchObject({
      fromStatus: 'learning',
      toStatus: 'mastered',
      fromStudyState: 'reviewing',
      toStudyState: 'mastered',
    })
    expect((await findWord('preview')).status).toBe('learning')

    const real = await batchStatus({
      ids: [String(doc._id)],
      target: 'mastered',
    })
    expect(real.body.words[0].studyState).toBe(preview.body.plan[0].toStudyState)
  })

  it('响应里的 studyCounts 与 GET /api/words 一致', async () => {
    const docs = await seed([
      { word: 'countone', status: 'learning' },
      { word: 'counttwo', status: 'mastered' },
      { word: 'countthree', status: 'new', source: 'basic-removed' },
    ])

    const res = await batchStatus({
      ids: docs.map((doc) => String(doc._id)),
      target: 'learning',
    })

    const listed = await list({ q: '', status: 'all', page: 1, pageSize: 10 })
    expect(res.body.studyCounts).toEqual(listed.body.studyCounts)
  })

  it('批量移除时清掉基础词页的「认识」标记', async () => {
    const [doc] = await seed([
      { word: removableWord.word, status: 'learning' },
    ])
    await BasicWordMark.create({ userId: uid, word: removableWord.word })

    const res = await batchStatus({
      ids: [String(doc._id)],
      target: 'removed',
    })

    expect(res.body.updated).toBe(1)
    expect(
      await BasicWordMark.countDocuments({
        userId: uid,
        word: removableWord.word,
      }),
    ).toBe(0)
  })
})

describe('POST /api/words/status/batch · 校验', () => {
  it('ids 为空 / 超过 200 / target 非法 / dryRun 非布尔 → 400', async () => {
    const empty = await batchStatus({ ids: [], target: 'mastered' })
    expect(empty.status).toBe(400)
    expect(empty.body.error.field).toBe('ids')

    const tooMany = await batchStatus({
      ids: Array.from({ length: 201 }, (_, index) =>
        String(index).padStart(24, '0'),
      ),
      target: 'mastered',
    })
    expect(tooMany.status).toBe(400)

    const badTarget = await batchStatus({ ids: ['a'], target: 'all' })
    expect(badTarget.status).toBe(400)
    expect(badTarget.body.error.field).toBe('target')

    const badDryRun = await batchStatus({
      ids: ['a'],
      target: 'mastered',
      dryRun: 'yes',
    })
    expect(badDryRun.status).toBe(400)
    expect(badDryRun.body.error.field).toBe('dryRun')
  })
})

describe('单条 PATCH 与导入的旁路', () => {
  it('单条 PATCH 不能把墓碑直接改成 learning', async () => {
    const [doc] = await seed([
      { word: 'tomb', status: 'new', source: 'basic-removed' },
    ])

    const res = await request(app)
      .patch(`/api/words/${doc._id}`)
      .send({ status: 'learning' })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BASIC_WORD_ALREADY_REMOVED')
  })

  it('批量导入把已有词改成 mastered 时清掉 nextReviewAt', async () => {
    await seed([
      {
        word: 'imported',
        status: 'learning',
        nextReviewAt: new Date(),
      },
    ])

    const res = await request(app)
      .post('/api/words/batch')
      .send({ words: [{ word: 'imported', status: 'mastered' }] })

    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(1)

    const doc = await findWord('imported')
    expect(doc.status).toBe('mastered')
    expect(doc.nextReviewAt).toBeNull()
    expect(doc.masteredAt).toBeTruthy()
  })

  it('批量导入把已有词改成 learning 时不会排到今天', async () => {
    await seed([{ word: 'untouchedword', status: 'new' }])

    const res = await request(app)
      .post('/api/words/batch')
      .send({ words: [{ word: 'untouchedword', status: 'learning' }] })

    expect(res.status).toBe(200)
    expect((await findWord('untouchedword')).nextReviewAt).toBeNull()
  })
})
