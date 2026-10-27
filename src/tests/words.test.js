import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { Word } from '../modules/words/word.model.js'

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

  it('重复单词 → 409 WORD_EXISTS，field=word', async () => {
    await post({ word: 'apple', source: 'manual', meaning: '苹果' })
    const res = await post({ word: 'APPLE', source: 'manual', meaning: '苹果' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'WORD_EXISTS', field: 'word' })
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

  it('手填词改词后用新释义重建 senses', async () => {
    const doc = await Word.create({
      userId: uid,
      word: 'gadget',
      source: 'manual',
      senses: [{ pos: '', meaning: '小装置' }],
    })

    const res = await patch(String(doc._id), { word: 'gizmo', meaning: '小玩意儿' })

    expect(res.status).toBe(200)
    expect(res.body.word).toBe('gizmo')
    expect(res.body.senses).toEqual([{ pos: '', meaning: '小玩意儿' }])
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
