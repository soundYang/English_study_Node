import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { BasicWordMark } from '../modules/basic-words/basic-word-mark.model.js'
import { Word } from '../modules/words/word.model.js'

const app = createApp()
const uid = config.defaultUserId

const list = (query) => request(app).get('/api/basic-words').query(query)
const remove = (word) => request(app).delete(`/api/basic-words/${word}`)
const restore = (word) => request(app).put(`/api/basic-words/${word}`)
const patch = (word, state) =>
  request(app).patch(`/api/basic-words/${word}`).send({ state })

/** 直接落库：走接口造「已认识 / 已移除」的前置状态会被接口自身的规则挡住 */
const seed = (docs) =>
  Word.insertMany(docs.map((doc) => ({ userId: uid, source: 'manual', ...doc })))

/** 直接落「认识」标记（md/52） */
const seedMark = (words) =>
  BasicWordMark.insertMany(words.map((word) => ({ userId: uid, word })))

/**
 * 词表口径（2026-10-28）：
 *   基础词 600 ∪ 日历词 19 ∪ 缩写 32，may 同时属于前两组 → 去重后 650
 *   其中可移除的只有 421 个实词（600 − 179 个功能词）
 */
const EMPTY_COUNTS = {
  all: 650,
  basic: 600,
  calendar: 19,
  abbreviation: 32,
  removable: 421,
  functionWord: 179,
  known: 0,
  learned: 0,
  removed: 0,
  untouched: 650,
}

/**
 * 把 650 条全翻出来。
 *
 * 单页最多 100 条，而口径断言要看整张表（may 不重复、removable 恰好 421），
 * 所以按页拉完再拼；只用于这些「整表」断言，分页行为本身另有独立用例。
 */
async function listEverything(query = {}) {
  const pageSize = 100
  const first = await list({ ...query, page: 1, pageSize })
  const pageCount = Math.ceil(first.body.total / pageSize)

  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
      list({ ...query, page: index + 2, pageSize }),
    ),
  )

  return {
    ...first.body,
    items: [first.body.items, ...rest.map((res) => res.body.items)].flat(),
  }
}

const listAll = () => listEverything()

describe('GET /api/basic-words', () => {
  it('空库返回整张词表的数字卡，三个状态数之和等于 all', async () => {
    const body = await listAll()

    expect(body.counts).toEqual(EMPTY_COUNTS)
    expect(body.total).toBe(650)
    expect(body.items).toHaveLength(650)

    const { known, removed, untouched, all } = body.counts
    expect(known + removed + untouched).toBe(all)
  })

  it('默认每页 50 条，按字母序从 a 开始', async () => {
    const res = await list({})

    expect(res.status).toBe(200)
    expect(res.body.page).toBe(1)
    expect(res.body.pageSize).toBe(50)
    expect(res.body.items).toHaveLength(50)
    expect(res.body.total).toBe(650)
    expect(res.body.items[0].word).toBe('a')

    const words = res.body.items.map((item) => item.word)
    expect(words).toEqual([...words].sort())
  })

  it('pageSize 超过 100 → 400，page 非数字 → 400', async () => {
    const tooBig = await list({ pageSize: 200 })
    expect(tooBig.status).toBe(400)
    expect(tooBig.body.error.code).toBe('INVALID_REQUEST')
    expect(tooBig.body.error.field).toBe('pageSize')

    const badPage = await list({ page: 'abc' })
    expect(badPage.status).toBe(400)
    expect(badPage.body.error.field).toBe('page')
  })

  it('页码越界收敛到末页，并返回收敛后的 page', async () => {
    const res = await list({ page: 99, pageSize: 100 })

    expect(res.body.page).toBe(7)
    expect(res.body.items).toHaveLength(50)
    expect(res.body.total).toBe(650)
  })

  it('group 分别筛出三组；未知值回落 all', async () => {
    const basic = await list({ group: 'basic' })
    const calendar = await list({ group: 'calendar' })
    const abbreviation = await list({ group: 'abbreviation' })
    const bogus = await list({ group: 'nonsense' })

    expect(basic.body.total).toBe(600)
    expect(calendar.body.total).toBe(19)
    expect(abbreviation.body.total).toBe(32)
    expect(bogus.body.total).toBe(650)
  })

  it('may 只出现一次，但按日历词筛也能找到它', async () => {
    const all = await listAll()
    const may = all.items.filter((item) => item.word === 'may')

    expect(may).toHaveLength(1)
    expect(may[0].kinds).toEqual(['basic', 'calendar'])
    expect(may[0].kind).toBe('basic')
    expect(may[0].calendarType).toBe('month')
    // 情态动词优先：may 是功能词，因此不可移除
    expect(may[0].isFunctionWord).toBe(true)
    expect(may[0].removable).toBe(false)

    const calendar = await list({ group: 'calendar', pageSize: 100 })
    expect(calendar.body.items.map((item) => item.word)).toContain('may')
  })

  it('日历词的音标 / 词性 / 释义来自词库（COCA 源里没有，由补录脚本补齐）', async () => {
    const res = await list({ group: 'calendar', pageSize: 100 })
    const byWord = Object.fromEntries(res.body.items.map((item) => [item.word, item]))

    expect(byWord.monday.phonetic).toEqual({ uk: '/ˈmʌndeɪ/', us: '/ˈmʌndeɪ/' })
    expect(byWord.monday.senses).toEqual([{ pos: 'n.', meaning: '星期一' }])
    expect(byWord.monday.summary).toBe('星期一')

    expect(byWord.january.summary).toBe('一月')

    // march 是基础词之外的日历词：补的「三月」排在最前，
    // 否则 buildSummary 只取前两条，卡片上看不到月份
    expect(byWord.march.summary.startsWith('三月')).toBe(true)

    // 19 个日历词全都要有义项，不能再出现「卡片上只有一个单词」
    expect(res.body.items.filter((item) => item.senses.length === 0)).toEqual([])
  })

  it('只有 421 个实词 removable，功能词 / 日历词 / 缩写一律只读', async () => {
    const body = await listAll()
    const byWord = Object.fromEntries(body.items.map((item) => [item.word, item]))

    expect(byWord.book.removable).toBe(true)
    expect(byWord.book.isFunctionWord).toBe(false)

    expect(byWord.the.removable).toBe(false)
    expect(byWord.the.isFunctionWord).toBe(true)

    expect(byWord.monday.removable).toBe(false)
    expect(byWord.monday.calendarType).toBe('weekday')

    expect(byWord.dr.removable).toBe(false)
    expect(byWord.dr.kind).toBe('abbreviation')

    expect(body.items.filter((item) => item.removable)).toHaveLength(421)
  })

  it('缩写带全称与中文释义，词库里没有它时不返回音标和义项', async () => {
    const res = await list({ group: 'abbreviation', pageSize: 100 })
    const byWord = Object.fromEntries(res.body.items.map((item) => [item.word, item]))

    expect(byWord.dr.expansion).toBe('doctor')
    expect(byWord.dr.expansionMeaning).toBe('医生；博士')
    // 5 个单词组成的全称要原样保留，不能截断
    expect(byWord.usa.expansion).toBe('United States of America')

    // 缩写不是词典词条：音标为 null、义项为空，页面靠 expansion 渲染
    expect(byWord.dr.phonetic).toBeNull()
    expect(byWord.dr.senses).toEqual([])
    expect(byWord.dr.summary).toBe('')
  })

  it('基础词的音标和义项取自词库，不取个人记录', async () => {
    // 个人记录里故意留空释义：页面显示的必须是词库里的「书；…」
    await seed([{ word: 'book', status: 'learning', senses: [] }])

    const res = await list({ q: 'book' })
    const book = res.body.items.find((item) => item.word === 'book')

    expect(book.phonetic).toEqual({ uk: '/bʊk/', us: '/bʊk/' })
    expect(book.senses.length).toBeGreaterThan(0)
    expect(book.summary).toContain('书')
    expect(book.personalStatus).toBe('learning')
  })

  it('状态筛选：known / removed / unknown 互不重叠且覆盖全表', async () => {
    await seed([
      { word: 'book', status: 'learning' },
      { word: 'water', status: 'mastered' },
      { word: 'tree', status: 'new', source: 'basic-removed' },
    ])

    const known = await list({ status: 'known' })
    const removed = await list({ status: 'removed' })
    const unknown = await list({ status: 'unknown' })

    expect(known.body.total).toBe(2)
    expect(removed.body.total).toBe(1)
    expect(removed.body.items[0].word).toBe('tree')
    expect(removed.body.items[0].removed).toBe(true)
    expect(unknown.body.total).toBe(647)

    expect(known.body.total + removed.body.total + unknown.body.total).toBe(650)
    // 数字卡不受 status 筛选影响
    expect(known.body.counts).toMatchObject({ learned: 2, removed: 1, untouched: 647 })
  })

  it('个人词库里 status=new 的手填词算「认识」，不再算「不认识」', async () => {
    // md/56 §18：只有 basic-removed 墓碑是「不认识」。
    // 按 status 判的话，用户正常添加的词会被显示成「不认识」、也不计入 knownWords
    await seed([{ word: 'book', status: 'new', source: 'manual' }])

    const removed = await list({ status: 'removed' })
    const known = await list({ status: 'known' })
    const book = known.body.items.find((item) => item.word === 'book')

    expect(removed.body.total).toBe(0)
    expect(known.body.total).toBe(1)
    expect(book.removed).toBe(false)
    expect(book.personalState).toBe('known')
    expect(book.personalStatus).toBe('new')
  })

  it('q 能匹配中文释义和缩写全称，空串不筛选', async () => {
    const byMeaning = await list({ q: '医生' })
    expect(byMeaning.body.items.map((item) => item.word)).toContain('dr')

    const byExpansion = await list({ q: 'united' })
    const words = byExpansion.body.items.map((item) => item.word)
    expect(words).toContain('usa')
    expect(words).toContain('uk')

    const empty = await list({ q: '   ' })
    expect(empty.body.total).toBe(650)
  })

  it('q 里的正则元字符按字面量处理，不会当通配符', async () => {
    const res = await list({ q: '(', pageSize: 100 })

    expect(res.status).toBe(200)
    // 通配符会把 650 条全捞出来；字面量只命中释义里真的带左括号的词
    expect(res.body.total).toBeLessThan(650)
    expect(res.body.total).toBeGreaterThan(0)
    for (const item of res.body.items) {
      const texts = [
        item.word,
        item.expansion,
        item.expansionMeaning,
        ...item.senses.map((sense) => sense.meaning),
      ]
      expect(texts.some((text) => String(text ?? '').includes('('))).toBe(true)
    }
  })

  it('q 超过 45 字符 → 400', async () => {
    const res = await list({ q: 'a'.repeat(46) })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('q')
  })
})

describe('DELETE /api/basic-words/:word', () => {
  it('标记不认识：写 basic-removed 记录并立刻反映到列表', async () => {
    const res = await remove('book')

    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({
      word: 'book',
      removed: true,
      personalStatus: 'new',
      removable: true,
    })
    expect(res.body.item.wordId).toBeTruthy()
    expect(res.body.counts).toMatchObject({ all: 650, learned: 0, removed: 1, untouched: 649 })

    const doc = await Word.findOne({ userId: uid, word: 'book' }).lean()
    expect(doc).toMatchObject({ status: 'new', source: 'basic-removed' })
    // 快照要带上词库信息，词汇页看到它时不该只剩一个光秃秃的单词
    expect(doc.dictionaryId).toBe('dict_book')
    expect(doc.senses.length).toBeGreaterThan(0)
    expect(doc.cocaRank).toBeGreaterThan(0)

    const listed = await list({ q: 'book' })
    expect(listed.body.items[0].removed).toBe(true)
    // 移除只改状态，不从词表里消失
    expect(listed.body.counts.all).toBe(650)
  })

  it('词形大小写不敏感', async () => {
    const res = await remove('BOOK')

    expect(res.status).toBe(200)
    expect(res.body.item.word).toBe('book')
  })

  it('功能词 → 403 FUNCTION_WORD_IMMUTABLE', async () => {
    const res = await remove('the')

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FUNCTION_WORD_IMMUTABLE')
    expect(res.body.error.details).toMatchObject({ word: 'the', kind: 'function_word' })
    expect(await Word.countDocuments({ userId: uid })).toBe(0)
  })

  it('日历词 → 403 BASIC_WORD_READONLY（kind=calendar）', async () => {
    const res = await remove('monday')

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('BASIC_WORD_READONLY')
    expect(res.body.error.details).toMatchObject({ word: 'monday', kind: 'calendar' })
  })

  it('缩写 → 403 BASIC_WORD_READONLY（kind=abbreviation）', async () => {
    const res = await remove('dr')

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('BASIC_WORD_READONLY')
    expect(res.body.error.details).toMatchObject({ word: 'dr', kind: 'abbreviation' })
  })

  it('不在词表里 → 404 BASIC_WORD_NOT_FOUND', async () => {
    const res = await remove('happy')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('BASIC_WORD_NOT_FOUND')
  })

  it('已经标过不认识 → 409 BASIC_WORD_ALREADY_REMOVED，不新增第二条', async () => {
    await seed([{ word: 'book', status: 'new', source: 'basic-removed' }])

    const res = await remove('book')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BASIC_WORD_ALREADY_REMOVED')
    expect(await Word.countDocuments({ userId: uid, word: 'book' })).toBe(1)
  })

  it('已经在词库里（learning）→ 409 BASIC_WORD_ALREADY_LEARNED，不覆盖进度', async () => {
    await seed([{ word: 'book', status: 'learning', articleExposureCount: 7 }])

    const res = await remove('book')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BASIC_WORD_ALREADY_LEARNED')
    expect(res.body.error.message).toContain('学习中')

    const doc = await Word.findOne({ userId: uid, word: 'book' }).lean()
    expect(doc.status).toBe('learning')
    expect(doc.articleExposureCount).toBe(7)
  })
})

describe('PUT /api/basic-words/:word', () => {
  it('恢复：删掉 basic-removed 记录，列表回到未标记', async () => {
    await seed([{ word: 'book', status: 'new', source: 'basic-removed' }])

    const res = await restore('book')

    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({
      word: 'book',
      removed: false,
      personalStatus: null,
      wordId: null,
    })
    expect(res.body.counts).toMatchObject({ learned: 0, removed: 0, untouched: 650 })
    expect(await Word.countDocuments({ userId: uid })).toBe(0)
  })

  it('没被移除过 → 409 BASIC_WORD_NOT_REMOVED', async () => {
    const res = await restore('book')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BASIC_WORD_NOT_REMOVED')
  })

  it('只读词同样不能恢复 → 403', async () => {
    const functionWord = await restore('the')
    const calendar = await restore('monday')

    expect(functionWord.status).toBe(403)
    expect(functionWord.body.error.code).toBe('FUNCTION_WORD_IMMUTABLE')
    expect(calendar.status).toBe(403)
    expect(calendar.body.error.code).toBe('BASIC_WORD_READONLY')
  })

  it('用户自己加的 new 词不会被删掉', async () => {
    await seed([{ word: 'book', status: 'new', source: 'manual' }])

    const res = await restore('book')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BASIC_WORD_ALREADY_LEARNED')
    expect(await Word.countDocuments({ userId: uid, word: 'book' })).toBe(1)
  })

  it('不在词表里 → 404 BASIC_WORD_NOT_FOUND', async () => {
    const res = await restore('happy')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('BASIC_WORD_NOT_FOUND')
  })
})

describe('PATCH /api/basic-words/:word（三态标记，md/52）', () => {
  it('未标记 → 认识：写一条标记记录，Word 表不动', async () => {
    const res = await patch('book', 'known')

    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({
      word: 'book',
      removed: false,
      personalState: 'known',
      knownSource: 'mark',
      personalStatus: null,
      wordId: null,
    })
    expect(res.body.counts).toMatchObject({
      known: 1,
      learned: 0,
      removed: 0,
      untouched: 649,
    })
    expect(await BasicWordMark.countDocuments({ userId: uid, word: 'book' })).toBe(1)
    // 认识不进「我的单词」，也不占词库上限
    expect(await Word.countDocuments({ userId: uid })).toBe(0)
  })

  it('不认识 → 认识：删掉 basic-removed 占位，改标记认识', async () => {
    await seed([{ word: 'book', status: 'new', source: 'basic-removed' }])

    const res = await patch('book', 'known')

    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ personalState: 'known', knownSource: 'mark' })
    expect(await Word.countDocuments({ userId: uid })).toBe(0)
    expect(await BasicWordMark.countDocuments({ userId: uid, word: 'book' })).toBe(1)
    expect(res.body.counts).toMatchObject({ known: 1, removed: 0, untouched: 649 })
  })

  it('认识 → 不认识：删标记，写 basic-removed 占位（带词库快照）', async () => {
    await seedMark(['book'])

    const res = await patch('book', 'unknown')

    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ personalState: 'removed', knownSource: null })
    expect(await BasicWordMark.countDocuments({ userId: uid, word: 'book' })).toBe(0)

    const doc = await Word.findOne({ userId: uid, word: 'book' }).lean()
    expect(doc).toMatchObject({ status: 'new', source: 'basic-removed', dictionaryId: 'dict_book' })
  })

  it('认识 → 未标记：只删标记', async () => {
    await seedMark(['book'])

    const res = await patch('book', 'none')

    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ personalState: 'untouched', knownSource: null })
    expect(await BasicWordMark.countDocuments({ userId: uid })).toBe(0)
    expect(await Word.countDocuments({ userId: uid })).toBe(0)
    expect(res.body.counts).toMatchObject({ known: 0, removed: 0, untouched: 650 })
  })

  it('不认识 → 未标记：删掉 basic-removed 占位', async () => {
    await seed([{ word: 'book', status: 'new', source: 'basic-removed' }])

    const res = await patch('book', 'none')

    expect(res.status).toBe(200)
    expect(res.body.item.personalState).toBe('untouched')
    expect(await Word.countDocuments({ userId: uid })).toBe(0)
  })

  it('词库里的词本来就是认识：known 是空操作，来源是 library', async () => {
    await seed([{ word: 'book', status: 'learning', articleExposureCount: 7 }])

    const res = await patch('book', 'known')

    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({
      personalState: 'known',
      knownSource: 'library',
      personalStatus: 'learning',
    })
    expect(res.body.item.wordId).toBeTruthy()
    // 词库中的词不需要再写一条标记
    expect(await BasicWordMark.countDocuments({ userId: uid })).toBe(0)

    const doc = await Word.findOne({ userId: uid, word: 'book' }).lean()
    expect(doc).toMatchObject({ status: 'learning', articleExposureCount: 7 })
  })

  it('词库中的词不能从基础词页改回不认识 / 未标记 → 409', async () => {
    await seed([{ word: 'book', status: 'learning', articleExposureCount: 7 }])

    const asUnknown = await patch('book', 'unknown')
    const asNone = await patch('book', 'none')

    expect(asUnknown.status).toBe(409)
    expect(asUnknown.body.error.code).toBe('BASIC_WORD_ALREADY_LEARNED')
    expect(asNone.status).toBe(409)
    expect(asNone.body.error.code).toBe('BASIC_WORD_ALREADY_LEARNED')

    const doc = await Word.findOne({ userId: uid, word: 'book' }).lean()
    expect(doc).toMatchObject({ status: 'learning', articleExposureCount: 7 })
  })

  it('用户自己加的词（含 new）：标认识 200，标未标记 / 不认识 409', async () => {
    // md/56 §18：词库里的词就是「认识」，包括状态还是 new 的。
    // 覆盖 status 等于抹掉学习进度，只能回词汇页做
    await seed([{ word: 'book', status: 'new', source: 'manual' }])

    const asKnown = await patch('book', 'known')
    const asNone = await patch('book', 'none')

    expect(asKnown.status).toBe(200)
    expect(asKnown.body.item.personalState).toBe('known')
    expect(asKnown.body.item.knownSource).toBe('library')
    expect(asNone.status).toBe(409)
    expect(asNone.body.error.code).toBe('BASIC_WORD_ALREADY_LEARNED')

    // 词库里已有，写不写墓碑都不该多一条记录
    expect(await Word.countDocuments({ userId: uid, word: 'book' })).toBe(1)
  })

  it('幂等：同一个状态连标两次，只留一条标记', async () => {
    const first = await patch('book', 'known')
    const second = await patch('book', 'known')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.item.personalState).toBe('known')
    expect(await BasicWordMark.countDocuments({ userId: uid, word: 'book' })).toBe(1)
  })

  it('只读词同样不能标记 → 403', async () => {
    const functionWord = await patch('the', 'known')
    const calendar = await patch('monday', 'known')
    const abbreviation = await patch('dr', 'known')

    expect(functionWord.status).toBe(403)
    expect(functionWord.body.error.code).toBe('FUNCTION_WORD_IMMUTABLE')
    expect(calendar.status).toBe(403)
    expect(calendar.body.error.code).toBe('BASIC_WORD_READONLY')
    expect(abbreviation.status).toBe(403)
    expect(abbreviation.body.error.code).toBe('BASIC_WORD_READONLY')
  })

  it('不在词表里 → 404；state 非法 → 400', async () => {
    const missing = await patch('happy', 'known')
    const invalid = await patch('book', 'maybe')

    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('BASIC_WORD_NOT_FOUND')
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.field).toBe('state')
  })

  it('状态筛选「认识」同时包含手动标记和词库里的词', async () => {
    await seedMark(['book'])
    await seed([{ word: 'water', status: 'mastered' }])

    const known = await list({ status: 'known' })
    const unknown = await list({ status: 'unknown' })

    expect(known.body.total).toBe(2)
    expect(known.body.items.map((item) => [item.word, item.knownSource])).toEqual([
      ['book', 'mark'],
      ['water', 'library'],
    ])
    expect(unknown.body.total).toBe(648)

    // 数字卡：known 含两类，learned 仍只算词库中的
    expect(known.body.counts).toMatchObject({
      known: 2,
      learned: 1,
      removed: 0,
      untouched: 648,
    })
    const { known: knownCount, removed, untouched, all } = known.body.counts
    expect(knownCount + removed + untouched).toBe(all)
  })

  it('DELETE 会顺手清掉此前的「认识」标记', async () => {
    await seedMark(['book'])

    const res = await remove('book')

    expect(res.status).toBe(200)
    expect(res.body.item.personalState).toBe('removed')
    expect(await BasicWordMark.countDocuments({ userId: uid })).toBe(0)
  })
})

describe('移除 / 恢复的闭环', () => {
  it('移除后生成链路看得到：status=new 的词从个人基础词里消失', async () => {
    const { getPersonalBasicWords, getBasicWords } = await import(
      '../modules/readings/basic-words.js'
    )

    expect(getBasicWords()).toContain('book')
    await remove('book')

    const removedWords = (await Word.find({ userId: uid, status: 'new' }).lean()).map(
      (doc) => doc.word,
    )
    expect(getPersonalBasicWords('easy', removedWords)).not.toContain('book')

    await restore('book')
    const afterRestore = await Word.find({ userId: uid, status: 'new' }).lean()
    expect(getPersonalBasicWords('easy', afterRestore.map((doc) => doc.word))).toContain('book')
  })
})
