import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import {
  dictionary,
  dictionaryStats,
  prefixIndex,
} from '../modules/dictionary/dictionary.loader.js'
import { resolveBaseForms } from '../shared/utils/word.js'

const app = createApp()
const search = (query) => request(app).get('/api/dictionary/search').query(query)

describe('词库加载', () => {
  it('过滤后剩 17417 条，剔除 212 条', () => {
    expect(dictionaryStats).toEqual({ rawTotal: 17629, filtered: 212, searchable: 17417 })
    expect(dictionary.size).toBe(17417)
  })

  it('26 个首字母分片都在', () => {
    expect(prefixIndex.size).toBe(26)
  })

  it('非法词头被剔除：and/or、his/her、he/she、sauté', () => {
    expect(dictionary.has('and/or')).toBe(false)
    expect(dictionary.has('his/her')).toBe(false)
    expect(dictionary.has('he/she')).toBe(false)
    expect(dictionary.has('sauté')).toBe(false)
  })

  it('大写词条转小写后合法，保留原始大小写', () => {
    const mba = dictionary.get('mba')
    expect(mba).toBeDefined()
    expect(mba.headword).toBe('MBA')
  })

  it('零义项词条被剔除', () => {
    expect(dictionary.has('all-american')).toBe(false)
  })
})

describe('GET /api/dictionary/search', () => {
  it('?q=aban 第一条是 abandon', async () => {
    const res = await search({ q: 'aban', limit: 8, _t: 1 })

    expect(res.status).toBe(200)
    expect(res.body.query).toBe('aban')
    expect(res.body.items[0].headword).toBe('abandon')
    expect(res.body.items[0].id).toBe('dict_abandon')
  })

  it('无匹配返回 200 + 空数组，不是 404', async () => {
    const res = await search({ q: 'zzz' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ query: 'zzz', items: [] })
  })

  it('?q=and 的结果里没有 and/or', async () => {
    const res = await search({ q: 'and', limit: 20 })

    expect(res.body.items.every((item) => item.headword !== 'and/or')).toBe(true)
  })

  it('空 q → 400 INVALID_QUERY', async () => {
    const res = await search({ q: '' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_QUERY')
  })

  it('缺 q → 400 INVALID_QUERY', async () => {
    const res = await request(app).get('/api/dictionary/search')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_QUERY')
  })

  it('q 含非法字符 → 400 INVALID_QUERY', async () => {
    const res = await search({ q: 'ab@n' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_QUERY')
  })

  it('q 超过 45 字符 → 400 INVALID_QUERY', async () => {
    const res = await search({ q: 'a'.repeat(46) })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_QUERY')
  })

  it('limit 被 clamp 到 1–20', async () => {
    const huge = await search({ q: 'a', limit: 999 })
    const zero = await search({ q: 'a', limit: 0 })

    expect(huge.body.items.length).toBe(20)
    expect(zero.body.items.length).toBe(1)
  })

  it('limit 非数字时回落默认值 8', async () => {
    const res = await search({ q: 'a', limit: 'abc' })

    expect(res.body.items.length).toBe(8)
  })

  it('phonetic 永远是对象，缺音标时单项为 null', async () => {
    const res = await search({ q: 'hmm' })

    expect(res.body.items.length).toBeGreaterThan(0)
    for (const item of res.body.items) {
      expect(typeof item.phonetic).toBe('object')
      expect(item.phonetic).not.toBeNull()
      expect(item.phonetic).toHaveProperty('uk')
      expect(item.phonetic).toHaveProperty('us')
    }
  })

  it('返回 source 与 fetchedAt（来自 meta.json）', async () => {
    const res = await search({ q: 'aban' })
    const [item] = res.body.items

    expect(item.source).toBe('coca-20000')
    expect(item.fetchedAt).toBe('2026-10-27T00:00:00.000Z')
    expect(item.senses.length).toBeGreaterThan(0)
  })

  it('完全匹配排在前缀匹配之前', async () => {
    const res = await search({ q: 'apple', limit: 20 })

    expect(res.body.items[0].headword.toLowerCase()).toBe('apple')
  })

  it('词形还原第二轮：went → go', async () => {
    const res = await search({ q: 'went', limit: 20 })

    expect(res.body.items.some((item) => item.headword === 'go')).toBe(true)
  })

  it('词形还原第二轮：stories → story', async () => {
    const res = await search({ q: 'stories', limit: 20 })

    expect(res.body.items.some((item) => item.headword === 'story')).toBe(true)
  })
})

describe('resolveBaseForms', () => {
  it.each([
    ['stories', 'story'],
    ['played', 'play'],
    ['running', 'run'],
    ['stopped', 'stop'],
    ['making', 'make'],
    ['happily', 'happy'],
    ['bigger', 'big'],
    ['tried', 'try'],
    ['watches', 'watch'],
    ['books', 'book'],
  ])('%s 包含词根 %s', (word, expected) => {
    expect(resolveBaseForms(word)).toContain(expected)
  })

  it('不规则变形走表：went → go、children → child', () => {
    expect(resolveBaseForms('went')).toContain('go')
    expect(resolveBaseForms('children')).toContain('child')
  })

  it('太短的词不产生候选', () => {
    expect(resolveBaseForms('is')).toEqual([])
  })
})
