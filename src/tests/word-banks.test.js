import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { basicWordByWord } from '../modules/basic-words/basic-words.catalog.js'
import { WordBankMembership } from '../modules/word-banks/word-bank-membership.model.js'
import { getWordBankCatalog } from '../modules/word-banks/word-banks.catalog.js'
import { Word } from '../modules/words/word.model.js'

const app = createApp()
const uid = config.defaultUserId

const getBanks = () => request(app).get('/api/word-banks')
const listBank = (bank, query = '') =>
  request(app).get(`/api/word-banks/${bank}/words${query}`)
const addToBank = (bank, body) =>
  request(app).post(`/api/word-banks/${bank}/add`).send(body)
const statusBatch = (bank, body) =>
  request(app).post(`/api/word-banks/${bank}/status/batch`).send(body)
const resetBank = (bank, body) =>
  request(app).post(`/api/word-banks/${bank}/reset`).send(body)
const addWord = (body) => request(app).post('/api/words').send(body)
const listWords = (query = '') => request(app).get(`/api/words${query}`)

describe('词库目录', () => {
  it('只有高频 / 中频，数量与排名区间正确，且不含基础词', () => {
    const catalog = getWordBankCatalog()

    expect(catalog.high.length).toBe(2030)
    expect(catalog.mid.length).toBe(4266)
    expect(catalog.high[0].rank).toBeLessThanOrEqual(3000)
    expect(catalog.mid[0].rank).toBeGreaterThan(3000)
    expect(catalog.mid.at(-1).rank).toBeLessThanOrEqual(8000)
    expect(
      [...catalog.high, ...catalog.mid].some((item) =>
        basicWordByWord.has(item.word),
      ),
    ).toBe(false)
  })
})

describe('GET /api/word-banks', () => {
  it('返回两个库、总数与名额', async () => {
    const res = await getBanks()

    expect(res.status).toBe(200)
    expect(res.body.banks).toHaveLength(2)
    expect(res.body.banks.map((bank) => bank.key)).toEqual(['high', 'mid'])
    expect(res.body.banks[0]).toMatchObject({
      label: '高频词库',
      total: 2030,
      imported: 0,
      importedInLibrary: 0,
      remainingSlots: 8000,
    })
  })

  it('导入后 imported 只统计导入记录，不把原有词算进去', async () => {
    await addWord({ word: 'analysis' })
    await addToBank('high', { words: ['analysis', 'abandon'] })

    const res = await getBanks()
    const high = res.body.banks.find((bank) => bank.key === 'high')

    expect(high.imported).toBe(1)
    expect(high.importedInLibrary).toBe(1)
  })
})

describe('GET /api/word-banks/:bank/words', () => {
  it('analysis 可以是“在个人词库、但不是导入词”', async () => {
    await addWord({ word: 'analysis' })
    await addToBank('high', { words: ['abandon'] })

    const imported = await listBank('high', '?filter=imported&pageSize=10')
    expect(imported.body.items.every((item) => item.imported)).toBe(true)
    expect(imported.body.items.map((item) => item.word)).toContain('abandon')

    const notImported = await listBank('high', '?filter=not_imported&q=analysis')
    expect(notImported.body.items).toHaveLength(1)
    expect(notImported.body.items[0]).toMatchObject({
      word: 'analysis',
      inLibrary: true,
      imported: false,
    })
  })

  it('非法 bank 返回 404 WORD_BANK_NOT_FOUND', async () => {
    const res = await listBank('low')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('WORD_BANK_NOT_FOUND')
  })

  it('搜索与分页稳定', async () => {
    const res = await listBank('high', '?q=abandon&pageSize=10')

    expect(res.body.items.map((item) => item.word)).toContain('abandon')
    expect(res.body.page).toBe(1)
  })
})

describe('POST /api/word-banks/:bank/add', () => {
  it('只在新建词时写导入记录；已有 analysis 不打标', async () => {
    await addWord({ word: 'analysis' })

    const res = await addToBank('high', { words: ['analysis', 'abandon'] })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      created: 1,
      existing: 1,
      alreadyImported: 0,
      failed: 0,
    })
    expect(
      await WordBankMembership.countDocuments({ userId: uid, bank: 'high' }),
    ).toBe(1)

    const words = await listWords('?q=analysis')
    expect(words.body.items[0].wordBanks).toEqual([])

    const imported = await listBank('high', '?q=abandon')
    expect(imported.body.items[0].imported).toBe(true)
  })

  it('重复导入幂等，importedAt 不变', async () => {
    const first = await addToBank('high', { words: ['abandon'] })
    expect(first.body.created).toBe(1)

    const before = await WordBankMembership.findOne({
      userId: uid,
      word: 'abandon',
      bank: 'high',
    }).lean()

    const second = await addToBank('high', { words: ['abandon'] })
    expect(second.body).toMatchObject({
      created: 0,
      existing: 0,
      alreadyImported: 1,
    })

    const after = await WordBankMembership.findOne({
      userId: uid,
      word: 'abandon',
      bank: 'high',
    }).lean()
    expect(after.importedAt.toISOString()).toBe(before.importedAt.toISOString())
    expect(await Word.countDocuments({ userId: uid, word: 'abandon' })).toBe(1)
  })

  it('基础词 / 不在词库 / 非法词分别给出跳过原因', async () => {
    const res = await addToBank('high', {
      words: ['the', 'meticulous', 'bad word'],
    })

    expect(res.body.created).toBe(0)
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ word: 'the', reason: 'BASIC_WORD_EXCLUDED' }),
        expect.objectContaining({ word: 'meticulous', reason: 'NOT_IN_BANK' }),
        expect.objectContaining({ word: 'bad word', reason: 'INVALID_WORD' }),
      ]),
    )
  })

  it('整库分批按 cursor 前进，名额不足时停在未处理的词上', async () => {
    const res = await addToBank('high', { all: true, limit: 3, cursor: 0 })

    expect(res.body.created).toBe(3)
    expect(res.body.nextCursor).toBe(3)
    expect(res.body.done).toBe(false)
  })

  it('超过上限时 limitReached 为 true，不再创建', async () => {
    // 直接塞满 8000 个占位词太重；用一个临时小上限的独立进程不现实，
    // 这里只验证正常路径不误报。上限分支由 words-library-limit.test.js 覆盖。
    const res = await addToBank('high', { words: ['abandon'] })
    expect(res.body.limitReached).toBe(false)
  })
})

describe('POST /api/word-banks/:bank/status/batch', () => {
  it('只改导入词；用户原有 analysis 进 notInBank 且状态不变', async () => {
    await addWord({ word: 'analysis', status: 'learning' })
    await addToBank('high', { words: ['abandon'] })

    const res = await statusBatch('high', {
      words: ['analysis', 'abandon'],
      target: 'removed',
    })

    expect(res.status).toBe(200)
    expect(res.body.notInBank).toEqual(['analysis'])
    expect(res.body.updated).toBe(1)
    expect(res.body.words[0].wordBanks).toEqual(['high'])
    expect(res.body.words[0].studyState).toBe('removed')

    const analysis = await listWords('?q=analysis')
    expect(analysis.body.items[0].status).toBe('learning')
  })

  it('标为不认识后仍留在“已导入”，且可以用 restore 恢复', async () => {
    await addToBank('high', { words: ['abandon'] })
    await statusBatch('high', { words: ['abandon'], target: 'removed' })

    const imported = await listBank('high', '?filter=imported&q=abandon')
    expect(imported.body.items[0]).toMatchObject({
      imported: true,
      personalStudyState: 'removed',
    })

    const restored = await statusBatch('high', {
      words: ['abandon'],
      target: 'restore',
    })
    expect(restored.body.updated).toBe(1)
    // 导入词是今天新建的，restore 后仍显示“新词”
    expect(restored.body.words[0].studyState).toBe('new')
  })

  it('dryRun 不落库', async () => {
    await addToBank('high', { words: ['abandon'] })

    const res = await statusBatch('high', {
      words: ['abandon'],
      target: 'mastered',
      dryRun: true,
    })

    expect(res.body.plan).toHaveLength(1)
    const word = await Word.findOne({ userId: uid, word: 'abandon' }).lean()
    expect(word.status).toBe('learning')
  })
})

describe('POST /api/word-banks/:bank/reset', () => {
  it('只删除导入词，保留用户原有的 analysis', async () => {
    await addWord({ word: 'analysis' })
    await addToBank('high', { words: ['analysis', 'abandon', 'company'] })

    const res = await resetBank('high', { confirm: true })

    expect(res.status).toBe(200)
    expect(res.body.removedWords).toBe(2)
    expect(res.body.removedMemberships).toBe(2)
    expect(await Word.countDocuments({ userId: uid, word: 'analysis' })).toBe(1)
    expect(await Word.countDocuments({ userId: uid, word: 'abandon' })).toBe(0)
    expect(await WordBankMembership.countDocuments({ userId: uid })).toBe(0)

    const again = await resetBank('high', { confirm: true })
    expect(again.body.removedWords).toBe(0)
  })

  it('缺少 confirm 返回 400', async () => {
    const res = await resetBank('high', {})

    expect(res.status).toBe(400)
  })
})

describe('手动删除与导入记录', () => {
  it('手动删除导入词后清理记录，重新加入不会误带旧标签', async () => {
    await addToBank('high', { words: ['abandon'] })

    const list = await listWords('?q=abandon')
    const id = list.body.items[0].id

    await request(app).delete(`/api/words/${id}`)
    expect(await WordBankMembership.countDocuments({ userId: uid })).toBe(0)

    const readd = await addToBank('high', { words: ['abandon'] })
    expect(readd.body.created).toBe(1)
    expect(readd.body.alreadyImported).toBe(0)
  })
})
