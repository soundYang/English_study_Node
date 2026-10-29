import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { config } from '../config/index.js'
import { MAX_BATCH_WORDS } from '../modules/words/word.schema.js'
import { Word } from '../modules/words/word.model.js'

/**
 * 提交前预检（md/44 §5.5）。
 *
 * 这个接口存在的唯一理由：把 409 从「提交后才知道」提前到「提交前就能看见」。
 * 所以每条都要给出 `action`，而非法词也一样返回 200——批量查询不能因为
 * 一个词打错就整批 400，否则前端拿不到其余词的结果。
 */
const app = createApp()
const uid = config.defaultUserId

const check = (body) => request(app).post('/api/words/check').send(body)

describe('POST /api/words/check', () => {
  it('逐条给出 create / reactivate / invalid', async () => {
    await Word.create({
      userId: uid,
      word: 'apple',
      status: 'new',
      source: 'basic-removed',
      dictionaryId: 'dict_apple',
      phonetic: { uk: '/ˈæpl/', us: null },
      senses: [{ pos: 'n.', meaning: '苹果' }],
    })

    const res = await check({
      words: ['abandon', 'apple', 'give up', 'zzzqqq'],
    })

    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(4)

    const [abandon, apple, phrase, unknown] = res.body.items

    expect(abandon).toMatchObject({
      word: 'abandon',
      valid: true,
      exists: false,
      wordId: null,
      action: 'create',
    })
    expect(abandon.dictionary).toMatchObject({ found: true, id: 'dict_abandon' })

    expect(apple).toMatchObject({
      word: 'apple',
      exists: true,
      status: 'new',
      source: 'basic-removed',
      action: 'reactivated',
    })
    expect(typeof apple.wordId).toBe('string')

    expect(phrase).toMatchObject({ word: 'give up', valid: false, action: 'invalid' })
    expect(phrase.reason).toContain('暂不支持短语')

    // 词库没有的词仍可手工添加，只是前端要提示补释义
    expect(unknown).toMatchObject({ word: 'zzzqqq', valid: true, action: 'create' })
    expect(unknown.dictionary).toEqual({ found: false, id: null, summary: '', senseCount: 0 })
  })

  it('大小写与重复输入按规范化后的词形回应', async () => {
    const res = await check({ words: ['Apple', 'APPLE'] })

    expect(res.body.items).toHaveLength(2)
    expect(res.body.items[0].word).toBe('apple')
    expect(res.body.items[1].word).toBe('apple')
  })

  it('已存在的 learning 词按请求状态判断是否要改', async () => {
    // 带释义：没有释义的手填词会被判成 enriched（词库补全），不是 kept
    await Word.create({
      userId: uid,
      word: 'apple',
      source: 'manual',
      status: 'learning',
      senses: [{ pos: '', meaning: '苹果' }],
    })

    const same = await check({ words: ['apple'] })
    expect(same.body.items[0].action).toBe('kept')

    const upgrade = await check({ words: ['apple'], status: 'mastered' })
    expect(upgrade.body.items[0].action).toBe('updated')
  })

  it('空数组 → 400', async () => {
    const res = await check({ words: [] })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('words')
  })

  it('超过上限 → 400', async () => {
    const words = Array.from({ length: MAX_BATCH_WORDS + 1 }, (_, index) => `word${index}`)

    const res = await check({ words })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('words')
  })

  it('words 不是数组 → 400', async () => {
    const res = await check({ words: 'apple' })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('words')
  })
})
