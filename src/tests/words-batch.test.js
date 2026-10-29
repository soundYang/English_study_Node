import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { Word } from '../modules/words/word.model.js'
import { MAX_BATCH_TEXT_LENGTH, MAX_BATCH_WORDS } from '../modules/words/word.schema.js'

/**
 * 批量导入（md/44 §5.4）。
 *
 * 这个接口的价值全在「一条坏数据不能毁掉整批」：
 * 20 个词里错 1 个，用户要的是把对的 19 个写进去，并且知道错的是哪一个。
 * 所以断言的重点是 counts、errors[].index 和 items 的顺序，不是「接口通不通」。
 */
const app = createApp()
const uid = config.defaultUserId

const batch = (body) => request(app).post('/api/words/batch').send(body)
const list = (query) => request(app).get('/api/words').query(query)

async function seedWord(doc) {
  return Word.create({ userId: uid, source: 'manual', ...doc })
}

describe('POST /api/words/batch', () => {
  it('混合输入：新建 / 合并 / 非法各归各位，计数与 index 正确', async () => {
    await seedWord({ word: 'apple', status: 'learning' })

    const res = await batch({
      words: [
        { word: 'serendipity', meaning: '意外发现美好事物的能力' },
        { word: 'abandon' },
        { word: 'and/or' },
        { word: 'apple', status: 'mastered' },
      ],
    })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      created: 2,
      updated: 1,
      skipped: 0,
      failed: 1,
      total: 4,
    })

    // 错误指回原输入的第 3 条（0 基）
    expect(res.body.errors).toHaveLength(1)
    expect(res.body.errors[0]).toMatchObject({
      index: 2,
      word: 'and/or',
      code: 'INVALID_REQUEST',
    })

    // items 按输入顺序，只含新建与更新的
    expect(res.body.items.map((item) => item.word)).toEqual([
      'serendipity',
      'abandon',
      'apple',
    ])

    // 没填释义的词自动从词库补全
    const abandon = await Word.findOne({ userId: uid, word: 'abandon' }).lean()
    expect(abandon.source).toBe('dictionary')
    expect(abandon.senses.length).toBeGreaterThan(0)

    expect((await Word.findOne({ userId: uid, word: 'apple' }).lean()).status).toBe('mastered')
  })

  it('批内重复只写一条，后出现的进 skippedItems', async () => {
    const res = await batch({
      words: [{ word: 'apple', meaning: '苹果' }, { word: 'APPLE', meaning: '苹果' }],
    })

    expect(res.body).toMatchObject({ created: 1, skipped: 1, failed: 0, total: 2 })
    expect(res.body.skippedItems).toEqual([
      { index: 1, word: 'apple', reason: 'DUPLICATE_IN_REQUEST' },
    ])
    expect(await Word.countDocuments({ userId: uid, word: 'apple' })).toBe(1)
  })

  it('文本模式：制表符 / 全角空格 / 中文间隔 / 注释 / 空行都能解析', async () => {
    const text = [
      '# 这一行是注释',
      'abandon\t放弃，抛弃',
      '',
      'apple　苹果',
      'gizmo 小玩意儿',
      'serendipity',
      '// 这一行也是注释',
    ].join('\n')

    const res = await batch({ text })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ created: 4, failed: 0, total: 4 })

    const rows = await Word.find({ userId: uid }).lean()
    const byWord = Object.fromEntries(rows.map((row) => [row.word, row]))

    // 命中词库：词库完整义项在前（带词性），用户释义被覆盖时不再重复存（md/51）
    expect(byWord.abandon.senses[0]).toEqual({
      pos: 'vt.',
      meaning: '放弃，抛弃；离弃，丢弃；使屈从；停止进行，终止',
    })
    expect(byWord.abandon.phonetic.uk).toMatch(/\//)
    expect(byWord.apple.senses[0]).toEqual({
      pos: 'n.',
      meaning: '苹果；苹果树；苹果公司',
    })
    // 「小玩意儿」词库没覆盖 → 追加在词库义项之后
    expect(byWord.gizmo.senses).toEqual([
      { pos: 'n.', meaning: '小发明' },
      { pos: '', meaning: '小玩意儿' },
    ])
    // 没有释义、词库也没有 → 允许存空释义的 manual 词
    expect(byWord.serendipity).toMatchObject({ source: 'manual', senses: [] })
  })

  it('短语给出专门提示，不会被当成非法字符', async () => {
    const res = await batch({ text: 'give up 放弃' })

    expect(res.body.created).toBe(0)
    expect(res.body.errors[0]).toMatchObject({ index: 0, word: 'give up' })
    expect(res.body.errors[0].message).toContain('暂不支持短语')
  })

  it('dryRun 只预览，不写库', async () => {
    await seedWord({ word: 'apple', status: 'learning' })
    const before = await Word.countDocuments({ userId: uid })

    const res = await batch({
      words: [{ word: 'apricot', meaning: '杏' }, { word: 'apple', status: 'mastered' }],
      dryRun: true,
    })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      dryRun: true,
      wouldCreate: 1,
      wouldUpdate: 1,
      wouldSkip: 0,
      invalid: 0,
    })
    expect(res.body.preview.map((item) => item.action)).toEqual(['create', 'updated'])

    expect(await Word.countDocuments({ userId: uid })).toBe(before)
    expect((await Word.findOne({ userId: uid, word: 'apple' }).lean()).status).toBe('learning')
  })

  it('onDuplicate=skip：已有词一条都不改', async () => {
    await seedWord({ word: 'apple', status: 'learning' })

    const res = await batch({
      words: [{ word: 'apple', status: 'mastered' }, { word: 'apricot', meaning: '杏' }],
      onDuplicate: 'skip',
    })

    expect(res.body).toMatchObject({ created: 1, updated: 0, skipped: 1, failed: 0 })
    expect((await Word.findOne({ userId: uid, word: 'apple' }).lean()).status).toBe('learning')
  })

  it('onDuplicate=error：重复项进 errors，其余照常写入', async () => {
    await seedWord({ word: 'apple', status: 'learning' })

    const res = await batch({
      words: [{ word: 'apple' }, { word: 'apricot', meaning: '杏' }],
      onDuplicate: 'error',
    })

    expect(res.body).toMatchObject({ created: 1, failed: 1, total: 2 })
    expect(res.body.errors[0]).toMatchObject({
      index: 0,
      word: 'apple',
      code: 'WORD_EXISTS',
    })
    expect(await Word.countDocuments({ userId: uid, word: 'apricot' })).toBe(1)
  })

  it('条目数超过上限 → 400，field=words', async () => {
    const words = Array.from({ length: MAX_BATCH_WORDS + 1 }, (_, index) => ({
      word: `word${index}`,
    }))

    const res = await batch({ words })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('words')
  })

  it('粘贴文本超长 → 400，field=text', async () => {
    const res = await batch({ text: 'a'.repeat(MAX_BATCH_TEXT_LENGTH + 1) })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('text')
  })

  it('words 与 text 都没给 → 400', async () => {
    const res = await batch({})

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('words')
  })

  it('导入后的词立即进入列表与计数', async () => {
    await batch({ text: 'apricot 杏\navocado 牛油果' })

    const res = await list({ q: '', status: 'learning', page: 1, pageSize: 10 })

    expect(res.body.total).toBe(2)
    expect(res.body.counts).toMatchObject({ all: 2, learning: 2 })
  })
})
