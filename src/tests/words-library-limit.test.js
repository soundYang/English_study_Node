import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 个人词库上限（md/44 §5.6）。
 *
 * 上限必须用真实的小值验证：默认 5000 在当前测试数据量下永远碰不到，
 * 等于这条分支从来没被执行过。
 *
 * `config` 是模块加载时冻结的，所以环境变量必须在动态 import 之前设置。
 */

process.env.WORD_LIBRARY_LIMIT = '3'

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()
const uid = config.defaultUserId

const post = (body) => request(app).post('/api/words').send(body)
const batch = (body) => request(app).post('/api/words/batch').send(body)

// 词形规则不允许数字：占位词必须是纯字母
const FILLERS = ['fillera', 'fillerb', 'fillerc']

async function seedFullLibrary(count = 3) {
  await Word.insertMany(
    FILLERS.slice(0, count).map((word) => ({
      userId: uid,
      word,
      source: 'manual',
      status: 'learning',
    })),
  )
}

describe('WORD_LIBRARY_LIMIT', () => {
  it('新建超过上限 → 409 WORD_LIMIT_REACHED，带 limit 明细', async () => {
    await seedFullLibrary()

    const res = await post({ word: 'apricot', meaning: '杏' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({
      code: 'WORD_LIMIT_REACHED',
      field: 'word',
      details: { limit: 3 },
    })
  })

  it('满库时合并已有词仍然可用（不增加条数）', async () => {
    await seedFullLibrary()

    const res = await post({ word: 'fillera', status: 'mastered' })

    expect(res.status).toBe(200)
    expect(res.body.action).toBe('updated')
    expect(await Word.countDocuments({ userId: uid })).toBe(3)
  })

  it('批量导入按剩余名额截断，超出部分逐条报 WORD_LIMIT_REACHED', async () => {
    await seedFullLibrary(2)

    const res = await batch({
      words: [
        { word: 'apricot', meaning: '杏' },
        { word: 'avocado', meaning: '牛油果' },
        { word: 'blueberry', meaning: '蓝莓' },
      ],
    })

    expect(res.body).toMatchObject({ created: 1, failed: 2, total: 3 })
    expect(res.body.errors.map((error) => error.word)).toEqual(['avocado', 'blueberry'])
    expect(res.body.errors.every((error) => error.code === 'WORD_LIMIT_REACHED')).toBe(true)
    expect(await Word.countDocuments({ userId: uid })).toBe(3)
  })

  it('dryRun 也把超限的条目报出来', async () => {
    await seedFullLibrary(2)

    const res = await batch({
      words: [
        { word: 'apricot', meaning: '杏' },
        { word: 'avocado', meaning: '牛油果' },
        { word: 'blueberry', meaning: '蓝莓' },
      ],
      dryRun: true,
    })

    expect(res.body).toMatchObject({ wouldCreate: 1, invalid: 2 })
    expect(res.body.preview[1]).toMatchObject({
      word: 'avocado',
      action: 'error',
      reason: 'WORD_LIMIT_REACHED',
    })
    expect(await Word.countDocuments({ userId: uid })).toBe(2)
  })
})
