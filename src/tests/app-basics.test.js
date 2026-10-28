import express from 'express'
import mongoose from 'mongoose'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { errorHandler } from '../shared/middleware/errorHandler.js'

/**
 * 基础链路回归（md/02 S2 / S5 / S11）。
 *
 * 这三条当初只用 curl 手验过，没有测试守护：
 *   1. /api/health 的 200 / 503 两种状态；
 *   2. 未知路由的 404 兜底；
 *   3. express.json 抛出的 400（非法 JSON）与 413（超过 64kb）。
 * 改动 app.js 的中间件顺序时，只有这里会变红。
 */
const app = createApp()

/** readyState 是 Connection 原型上的 getter：给实例定义一个同名属性即可遮蔽，删掉就恢复 */
function mockReadyState(value) {
  Object.defineProperty(mongoose.connection, 'readyState', {
    configurable: true,
    get: () => value,
  })

  return () => {
    delete mongoose.connection.readyState
  }
}

afterEach(() => {
  // 万一断言失败跳过了 restore，这里兜底，避免污染后续用例
  delete mongoose.connection.readyState
})

describe('GET /api/health', () => {
  it('mongo 已连接 → 200，词库数字是过滤后的可检索条数', async () => {
    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok', mongo: 'connected' })
    // 17436 是可检索条数；17648 是原始条数，写错这个数会让「健康」看起来正常但检索缺词
    expect(res.body.dictionary.words).toBe(17436)
    expect(typeof res.body.dictionary.loadedAt).toBe('string')
  })

  it('mongo 未连接 → 503 + degraded', async () => {
    const restore = mockReadyState(0)

    try {
      const res = await request(app).get('/api/health')

      expect(res.status).toBe(503)
      expect(res.body).toEqual({
        status: 'degraded',
        mongo: 'disconnected',
        dictionary: { words: 17436, loadedAt: expect.any(String) },
      })
    } finally {
      restore()
    }
  })
})

describe('未知路由', () => {
  it('返回统一错误体，不是 HTML', async () => {
    const res = await request(app).get('/api/not-a-route')

    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: '接口不存在' },
    })
  })
})

describe('请求体解析失败', () => {
  it('非法 JSON → 400 INVALID_REQUEST，不落进 500', async () => {
    const res = await request(app)
      .post('/api/words')
      .set('Content-Type', 'application/json')
      .send('{"word":')

    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({
      code: 'INVALID_REQUEST',
      message: '请求体不是合法 JSON',
    })
  })

  it('超过 64kb → 413，而不是 500', async () => {
    const huge = JSON.stringify({ word: 'x', padding: 'a'.repeat(70 * 1024) })
    const res = await request(app)
      .post('/api/words')
      .set('Content-Type', 'application/json')
      .send(huge)

    expect(res.status).toBe(413)
    expect(res.body.error).toEqual({
      code: 'INVALID_REQUEST',
      message: '请求体过大',
    })
  })
})

describe('未捕获异常', () => {
  it('500 只回固定文案，不漏原始 message 与堆栈', async () => {
    const mini = express()
    mini.get('/boom', () => {
      throw new Error('mongodb://user:pass@internal/db 连接失败')
    })
    mini.use(errorHandler)

    const res = await request(mini).get('/boom')

    expect(res.status).toBe(500)
    expect(res.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
    })
    // 红线：上游/库里的原始信息一律不出现
    expect(JSON.stringify(res.body)).not.toContain('internal')
    expect(JSON.stringify(res.body)).not.toContain('pass')
  })
})
