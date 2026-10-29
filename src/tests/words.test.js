import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { Word } from '../modules/words/word.model.js'
import { getWordRank } from '../modules/words/word-ranks.js'

const app = createApp()
const uid = config.defaultUserId

const get = (query) => request(app).get('/api/words').query(query)
const post = (body) => request(app).post('/api/words').send(body)
const patch = (id, body) => request(app).patch(`/api/words/${id}`).send(body)
const del = (id) => request(app).delete(`/api/words/${id}`)

/** 直接落库，比走接口快，也不会被接口自身的规则干扰 */
const seed = (docs) =>
  Word.insertMany(docs.map((doc) => ({ userId: uid, source: 'manual', ...doc })))

const EMPTY_COUNTS = { all: 0, mastered: 0, learning: 0, new: 0 }

describe('GET /api/words', () => {
  it('空库返回齐全的 counts 四个键', async () => {
    const res = await get({ q: '', status: 'all', page: 1, pageSize: 10, _t: 1 })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      counts: EMPTY_COUNTS,
    })
  })

  it('counts 统计全量，不受 status 筛选影响', async () => {
    await seed([
      { word: 'alpha', status: 'mastered' },
      { word: 'beta', status: 'learning' },
      { word: 'gamma', status: 'new' },
    ])

    const res = await get({ q: '', status: 'learning', page: 1, pageSize: 10 })

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.counts).toEqual({ all: 3, mastered: 1, learning: 1, new: 1 })
  })

  it('total 随 q 筛选变化，counts 不变', async () => {
    await seed([{ word: 'apple' }, { word: 'banana' }])

    const res = await get({ q: 'app', status: 'all', page: 1, pageSize: 10 })

    expect(res.body.total).toBe(1)
    expect(res.body.counts.all).toBe(2)
  })

  it('页码越界收敛到最后一页，并返回收敛后的 page', async () => {
    await seed(
      Array.from({ length: 12 }, (_, i) => ({ word: `w${String(i).padStart(2, '0')}` })),
    )

    const res = await get({ q: '', status: 'all', page: 999, pageSize: 10 })

    expect(res.body.page).toBe(2)
    expect(res.body.items).toHaveLength(2)
    expect(res.body.total).toBe(12)
  })

  it('q 含正则元字符不会 500，按字面量匹配', async () => {
    await seed([{ word: 'apple' }])

    const res = await get({ q: '(', status: 'all', page: 1, pageSize: 10 })

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(0)
  })

  it('q 里的 . 不会命中全表', async () => {
    await seed([{ word: 'apple' }, { word: 'banana' }])

    const res = await get({ q: '.', status: 'all', page: 1, pageSize: 10 })

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(0)
  })

  it('q 能匹配 senses[].meaning', async () => {
    await seed([
      { word: 'apple', senses: [{ pos: '', meaning: '苹果' }] },
      { word: 'banana', senses: [{ pos: '', meaning: '香蕉' }] },
    ])

    const res = await get({ q: '苹果', status: 'all', page: 1, pageSize: 10 })

    expect(res.body.total).toBe(1)
    expect(res.body.items[0].word).toBe('apple')
  })

  it('pageSize 超过 100 → 400', async () => {
    const res = await get({ q: '', status: 'all', page: 1, pageSize: 200 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.field).toBe('pageSize')
  })

  it('page 非数字 → 400', async () => {
    const res = await get({ q: '', status: 'all', page: 'abc' })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('page')
  })

  it('summary 取前两条义项，超 30 字截断', async () => {
    await Word.create({
      userId: uid,
      word: 'apt',
      source: 'dictionary',
      dictionaryId: 'dict_apt',
      phonetic: { uk: '/æpt/', us: null },
      senses: [
        { pos: 'adj.', meaning: '恰当的' },
        { pos: 'adj.', meaning: '聪明的' },
        { pos: 'adj.', meaning: '第三条不该出现' },
      ],
    })
    await Word.create({
      userId: uid,
      word: 'longword',
      source: 'dictionary',
      dictionaryId: 'dict_longword',
      phonetic: { uk: null, us: null },
      senses: [
        { pos: 'n.', meaning: '一'.repeat(20) },
        { pos: 'n.', meaning: '二'.repeat(20) },
      ],
    })

    const res = await get({ q: '', status: 'all', page: 1, pageSize: 10 })
    const byWord = Object.fromEntries(res.body.items.map((i) => [i.word, i]))

    expect(byWord.apt.summary).toBe('恰当的；聪明的')
    // 20 + 1（分号）+ 20 = 41 字，截到 30 = 20 个「一」+ 分号 + 9 个「二」
    expect(byWord.longword.summary).toBe(`${'一'.repeat(20)}；${'二'.repeat(9)}…`)
    expect(byWord.apt.phonetic).toEqual({ uk: '/æpt/', us: null })
  })
})

describe('列表 DTO 的 cocaRank（English_vue/md/13 C1）', () => {
  it('词库词带排名，手填词为 null 且键始终存在', async () => {
    await seed([
      { word: 'apple', cocaRank: 2201 },
      { word: 'handwritten', cocaRank: null },
    ])

    const res = await get({ q: '', status: 'all', page: 1, pageSize: 10 })
    const byWord = Object.fromEntries(res.body.items.map((item) => [item.word, item]))

    expect(byWord.apple.cocaRank).toBe(2201)
    // null 而不是 0：0 会被前端当成「排名第 0」，即最高频
    expect(byWord.handwritten).toHaveProperty('cocaRank', null)
  })
})

describe('POST /api/words', () => {
  it('手填词 201，phonetic 为 null、pos 为空串', async () => {
    const res = await post({
      word: 'Serendipity',
      status: 'learning',
      source: 'manual',
      meaning: '意外发现美好事物的能力',
    })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      word: 'serendipity',
      status: 'learning',
      source: 'manual',
      dictionaryId: null,
      phonetic: null,
      senses: [{ pos: '', meaning: '意外发现美好事物的能力' }],
      summary: '意外发现美好事物的能力',
    })
    expect(typeof res.body.id).toBe('string')
    expect(typeof res.body.createdAt).toBe('string')
  })

  it('重复单词 + onDuplicate=error → 409 WORD_EXISTS，field=word（旧行为）', async () => {
    await post({ word: 'apple', source: 'manual', meaning: '苹果' })
    const res = await post({
      word: 'APPLE',
      source: 'manual',
      meaning: '苹果',
      onDuplicate: 'error',
    })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'WORD_EXISTS', field: 'word' })
  })

  it('手填但没填释义 → 服务端回查词库补快照（md/44 §5.2）', async () => {
    const res = await post({ word: 'Abandon', source: 'manual' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      word: 'abandon',
      source: 'dictionary',
      dictionaryId: 'dict_abandon',
    })
    expect(res.body.phonetic.uk).toMatch(/\//)
    expect(res.body.senses.length).toBeGreaterThan(0)
  })

  it('手填且填了释义 → 仍存 manual，但词库快照照样补全（md/51）', async () => {
    const res = await post({ word: 'abandon', source: 'manual', meaning: '我的记法' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      word: 'abandon',
      source: 'manual',
      dictionaryId: 'dict_abandon',
    })
    // 音标、词性、词库完整义项一个都不少
    expect(res.body.phonetic.uk).toMatch(/\//)
    expect(res.body.senses[0].pos).toBe('vt.')

    // 词库覆盖不到的「自己的记法」追加到最后，不能被丢掉
    expect(res.body.senses.at(-1)).toEqual({ pos: '', meaning: '我的记法' })
    expect(res.body.senses.length).toBeGreaterThan(1)
  })

  it('手填释义已被词库义项覆盖 → 不重复追加', async () => {
    const res = await post({ word: 'abandon', source: 'manual', meaning: '放弃' })

    expect(res.status).toBe(201)
    expect(res.body.source).toBe('manual')
    // 「放弃」被「放弃，抛弃；离弃…」包含，词库说法更完整，不再单存一条
    expect(res.body.senses.every((sense) => sense.pos !== '')).toBe(true)
    expect(res.body.senses.filter((sense) => sense.meaning === '放弃')).toHaveLength(0)
  })

  it('手填词库没有的词 + 释义 → 仍是单条无词性义项', async () => {
    const res = await post({ word: 'zzzqqq', source: 'manual', meaning: '自造词' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ source: 'manual', dictionaryId: null, phonetic: null })
    expect(res.body.senses).toEqual([{ pos: '', meaning: '自造词' }])
  })

  it('非法字符 and/or → 400，field=word', async () => {
    const res = await post({ word: 'and/or', source: 'manual' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'word' })
  })

  it('缺 word → 400，field=word', async () => {
    const res = await post({ source: 'manual', meaning: '随便' })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('word')
  })

  it('status 非法回落 learning，不报 400', async () => {
    const res = await post({ word: 'banana', source: 'manual', status: 'bogus' })

    expect(res.status).toBe(201)
    expect(res.body.status).toBe('learning')
  })

  it('手填释义超过 100 字 → 400，field=meaning', async () => {
    const res = await post({
      word: 'gadget',
      source: 'manual',
      meaning: '字'.repeat(101),
    })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'meaning' })
  })

  it('source=dictionary 时音标与义项以服务端词库为准，忽略请求体', async () => {
    const res = await post({
      word: 'Abandon',
      source: 'dictionary',
      dictionaryId: 'dict_fake',
      phonetic: { uk: '假音标', us: '假音标' },
      senses: [{ pos: '假词性', meaning: '假释义' }],
    })

    expect(res.status).toBe(201)
    expect(res.body.word).toBe('abandon')
    expect(res.body.source).toBe('dictionary')
    expect(res.body.dictionaryId).toBe('dict_abandon')
    expect(res.body.phonetic.uk).toMatch(/\//)
    expect(res.body.senses.length).toBeGreaterThan(0)
    expect(res.body.senses[0].meaning).not.toBe('假释义')
  })

  it('词库中查不到的词 → 400 DICTIONARY_ENTRY_NOT_FOUND', async () => {
    const res = await post({ word: 'zzzznotaword', source: 'dictionary' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DICTIONARY_ENTRY_NOT_FOUND')
  })
})

/**
 * md/44 §5.3：重复词不再是一条死路。
 *
 * 最要紧的不是「200 而不是 409」，而是合并之后**学习进度与用户释义都还在**——
 * 覆盖掉就是拿一次误操作抹掉几个月的复习记录。
 */
describe('重复词合并', () => {
  it('默认 auto：同状态 → 200 action=kept，库内仍只有一条', async () => {
    await post({ word: 'apple', source: 'manual', meaning: '苹果' })

    const res = await post({ word: 'apple', source: 'manual', meaning: '苹果' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      word: 'apple',
      status: 'learning',
      duplicate: true,
      action: 'kept',
    })
    expect(await Word.countDocuments({ userId: uid, word: 'apple' })).toBe(1)
  })

  it('learning → mastered：更新状态，不重置复习时间与曝光次数', async () => {
    const reviewedAt = new Date('2026-10-01T00:00:00.000Z')
    const doc = await Word.create({
      userId: uid,
      word: 'apple',
      source: 'manual',
      status: 'learning',
      lastReviewedAt: reviewedAt,
      articleExposureCount: 4,
    })

    const res = await post({ word: 'apple', status: 'mastered' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'mastered', action: 'updated' })

    const after = await Word.findById(doc._id).lean()
    expect(after.status).toBe('mastered')
    expect(after.lastReviewedAt).toEqual(reviewedAt)
    expect(after.articleExposureCount).toBe(4)
  })

  it('basic-removed 占位词重新添加 → reactivated，source 不再是不认识', async () => {
    const reviewedAt = new Date('2026-10-02T00:00:00.000Z')
    const doc = await Word.create({
      userId: uid,
      word: 'apple',
      status: 'new',
      source: 'basic-removed',
      dictionaryId: 'dict_apple',
      phonetic: { uk: '/ˈæpl/', us: null },
      senses: [{ pos: 'n.', meaning: '苹果' }],
      articleExposureCount: 2,
      lastReviewedAt: reviewedAt,
    })

    const res = await post({ word: 'apple', status: 'learning' })

    expect(res.status).toBe(200)
    expect(res.body.action).toBe('reactivated')

    const after = await Word.findById(doc._id).lean()
    expect(after.status).toBe('learning')
    expect(after.source).toBe('dictionary')
    // 移除时写进去的快照还在，不该被清空
    expect(after.senses).toEqual([{ pos: 'n.', meaning: '苹果' }])
    expect(after.articleExposureCount).toBe(2)
    expect(after.lastReviewedAt).toEqual(reviewedAt)
  })

  it('手填空释义 + 词库命中 → enriched 补快照', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'abandon',
      source: 'manual',
      senses: [],
    })

    const res = await post({ word: 'abandon' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ action: 'enriched', source: 'dictionary' })
    expect(res.body.senses.length).toBeGreaterThan(0)
    expect((await Word.findById(doc._id).lean()).dictionaryId).toBe('dict_abandon')
  })

  it('手填空释义 + 这次带了释义 → 词库快照与用户释义一起补上', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'gadget',
      source: 'manual',
      senses: [],
    })

    const res = await post({ word: 'gadget', source: 'manual', meaning: '小装置' })

    expect(res.body.action).toBe('enriched')
    expect(res.body.senses).toEqual([
      { pos: 'n.', meaning: '小玩意；小配件；小装置' },
    ])
    expect((await Word.findById(doc._id).lean()).dictionaryId).toBe('dict_gadget')
  })

  it('已有非空手填释义 → 词库命中也不覆盖', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'abandon',
      source: 'manual',
      senses: [{ pos: '', meaning: '我的记法' }],
    })

    const res = await post({
      word: 'abandon',
      source: 'manual',
      meaning: '服务端不该用这条',
    })

    expect(res.body.senses).toEqual([{ pos: '', meaning: '我的记法' }])
    expect((await Word.findById(doc._id).lean()).senses[0].meaning).toBe('我的记法')
  })

  it('onDuplicate=skip → 200 且完全不改库', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'apple',
      source: 'manual',
      status: 'learning',
    })

    const res = await post({ word: 'apple', status: 'mastered', onDuplicate: 'skip' })

    expect(res.status).toBe(200)
    expect(res.body.action).toBe('kept')
    expect((await Word.findById(doc._id).lean()).status).toBe('learning')
  })

  it('includeCounts → counts / total 与列表接口一致', async () => {
    await post({ word: 'apple', source: 'manual', meaning: '苹果' })
    const res = await post({
      word: 'banana',
      source: 'manual',
      meaning: '香蕉',
      includeCounts: true,
    })

    expect(res.body.total).toBe(2)
    expect(res.body.counts).toMatchObject({ all: 2, learning: 2 })

    const list = await get({ q: '', status: 'all', page: 1, pageSize: 10 })
    expect(res.body.counts).toEqual(list.body.counts)
    expect(res.body.total).toBe(list.body.total)
  })
})

describe('PATCH /api/words/:id', () => {
  it('404 优先于只读字段检查', async () => {
    const res = await patch('66f0c1a2b3c4d5e6f7a8b9c0', { source: 'manual' })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('WORD_NOT_FOUND')
  })

  it('非法 ObjectId → 404 而不是 500', async () => {
    const res = await patch('not-an-id', { status: 'mastered' })

    expect(res.status).toBe(404)
  })

  it('试图改只读字段 → 400 READONLY_FIELD，带 field', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'apple',
      source: 'dictionary',
      dictionaryId: 'dict_apple',
      phonetic: { uk: '/a/', us: '/a/' },
      senses: [{ pos: 'n.', meaning: '苹果' }],
    })

    const res = await patch(String(doc._id), { senses: [] })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'READONLY_FIELD', field: 'senses' })
  })

  it('词库词传 meaning → 400 READONLY_FIELD，field=meaning', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'apple',
      source: 'dictionary',
      senses: [{ pos: 'n.', meaning: '苹果' }],
    })

    const res = await patch(String(doc._id), { meaning: '想改' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'READONLY_FIELD', field: 'meaning' })
  })

  it('status 非法 → 400，field=status', async () => {
    const doc = await Word.create({ userId: uid, word: 'apple', source: 'manual' })

    const res = await patch(String(doc._id), { status: 'bogus' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'status' })
  })

  it('改词后词库词降级为手填，音标与义项清空', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'apple',
      source: 'dictionary',
      dictionaryId: 'dict_apple',
      phonetic: { uk: '/a/', us: '/a/' },
      senses: [{ pos: 'n.', meaning: '苹果' }],
    })

    const res = await patch(String(doc._id), { word: 'apples' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      word: 'apples',
      source: 'manual',
      dictionaryId: null,
      phonetic: null,
      senses: [],
    })
  })

  it('手填词改词后按新词重建 senses（词库命中就带词性）', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'gadget',
      source: 'manual',
      senses: [{ pos: '', meaning: '小装置' }],
    })

    const res = await patch(String(doc._id), { word: 'gizmo', meaning: '小玩意儿' })

    expect(res.status).toBe(200)
    expect(res.body.word).toBe('gizmo')
    expect(res.body).toMatchObject({ dictionaryId: 'dict_gizmo' })
    // 新词命中词库：词库义项在前，用户这次给的释义没被覆盖，追加在后
    expect(res.body.senses).toEqual([
      { pos: 'n.', meaning: '小发明' },
      { pos: '', meaning: '小玩意儿' },
    ])
  })

  it('只改释义 → 重新合并词库，词性不会丢；自己的释义仍在', async () => {
    const res = await post({ word: 'abandon', source: 'manual', meaning: '我的记法' })
    const doc = await Word.findById(res.body.id).lean()

    const patched = await patch(String(doc._id), { meaning: '放弃' })

    expect(patched.status).toBe(200)
    expect(patched.body.senses[0].pos).toBe('vt.')
    // 之前那条自己的记法不是这次改的那条，必须保留
    expect(patched.body.senses.at(-1)).toEqual({ pos: '', meaning: '我的记法' })
  })

  it('改名撞已有单词 → 409 WORD_EXISTS', async () => {
    await seed([{ word: 'apple' }, { word: 'banana' }])
    const banana = await Word.findOne({ userId: uid, word: 'banana' })

    const res = await patch(String(banana._id), { word: 'apple' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'WORD_EXISTS', field: 'word' })
  })
})

describe('DELETE /api/words/:id', () => {
  it('删除成功返回 { id, total }，total 是删除后的总数', async () => {
    await seed([{ word: 'apple' }, { word: 'banana' }])
    const apple = await Word.findOne({ userId: uid, word: 'apple' })

    const res = await del(String(apple._id))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: String(apple._id), total: 1 })
  })

  it('不存在的 id → 404', async () => {
    const res = await del('66f0c1a2b3c4d5e6f7a8b9c0')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('WORD_NOT_FOUND')
  })

  it('非法 ObjectId → 404 而不是 500', async () => {
    const res = await del('not-an-id')

    expect(res.status).toBe(404)
  })
})

/**
 * P1 新增字段。
 *
 * 断言用 getWordRank() 对照而不是写死 2201：排名表会随词库重建而变，
 * 写死数字会让这条用例在无关的改动里莫名其妙地红。
 */
describe('P1 字段：cocaRank 与复习统计', () => {
  it('新增词库词时写入 COCA 排名', async () => {
    const res = await post({ word: 'Abandon', source: 'dictionary' })

    expect(res.status).toBe(201)

    const doc = await Word.findOne({ userId: uid, word: 'abandon' }).lean()
    expect(doc.cocaRank).toBe(getWordRank('abandon'))
    expect(typeof doc.cocaRank).toBe('number')
  })

  it('排名表里没有的词（手填）存 null，而不是 0 或省略', async () => {
    await post({ word: 'zzzqqq', source: 'manual', meaning: '自造词' })

    const doc = await Word.findOne({ userId: uid, word: 'zzzqqq' }).lean()
    expect(doc.cocaRank).toBeNull()
  })

  it('改词形后排名跟随新词', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'abandon',
      source: 'manual',
      cocaRank: getWordRank('abandon'),
    })

    const res = await patch(String(doc._id), { word: 'may' })

    expect(res.status).toBe(200)

    const updated = await Word.findById(doc._id).lean()
    expect(updated.cocaRank).toBe(getWordRank('may'))
    expect(updated.cocaRank).not.toBe(getWordRank('abandon'))
  })

  it('老文档缺新字段时按默认值读取', async () => {
    await seed([{ word: 'legacy' }])

    const doc = await Word.findOne({ userId: uid, word: 'legacy' }).lean()
    expect(doc.lastReviewedAt).toBeNull()
    expect(doc.articleExposureCount).toBe(0)
    expect(doc.lastArticleExposureAt).toBeNull()
    expect(doc.cocaRank).toBeNull()
  })
})
