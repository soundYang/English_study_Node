import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * W9 限流。
 *
 * `setup.js` 把 RATE_LIMIT_ENABLED 固定为 false。这个文件要验证**开启后**的行为，
 * 所以必须在 config 被导入之前改环境变量——下面一律用动态 import（同 word-expand.test.js）。
 */
process.env.RATE_LIMIT_ENABLED = 'true'
// 配额压到 2 次：既能测到 429，又不用真的打 21 个请求
process.env.RATE_LIMIT_GENERATE = '2'

const { createApp } = await import('../app.js')
const { createGenerateLimiter } = await import('../shared/middleware/rateLimit.js')
const { errorHandler } = await import('../shared/middleware/errorHandler.js')

const app = createApp()

/**
 * 故意用非法请求体：zod 在第一行就拒掉，既不碰数据库也不调模型。
 * 限流按请求数计数（不看响应码），400 一样占配额。
 */
const badGenerate = () =>
  request(app).post('/api/readings/generate').send({ level: 'insane' })

/** 最小的独立应用：只为了拿到一个干净的计数器，不和下面的用例互相污染 */
function miniApp(options) {
  const mini = express()
  mini.get('/x', createGenerateLimiter(options), (req, res) => res.json({ ok: true }))
  // 复用真实出口，才能断言 429 的响应体形态（否则是 Express 的 HTML 错误页）
  mini.use(errorHandler)
  return mini
}

describe('createGenerateLimiter', () => {
  it('额度用尽后返回 429，响应体与其它业务错误同形', async () => {
    const mini = miniApp({ limit: 2, enabled: true })

    expect((await request(mini).get('/x')).status).toBe(200)
    const second = await request(mini).get('/x')
    expect(second.status).toBe(200)
    // draft-7 的合并头：第 2 次打完剩余次数正好是 0
    expect(second.headers['ratelimit']).toContain('remaining=0')

    const blocked = await request(mini).get('/x')
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.body.error.message).toContain('每分钟最多 2 次')
    // details 给前端做倒计时，不用自己解析响应头
    expect(blocked.body.error.details).toEqual({ limit: 2, windowSeconds: 60 })
  })

  it('关闭时一次也不拦（测试环境的默认状态）', async () => {
    const mini = miniApp({ limit: 1, enabled: false })

    for (let index = 0; index < 3; index += 1) {
      expect((await request(mini).get('/x')).status).toBe(200)
    }
  })
})

describe('挂载范围', () => {
  it('/capacity 不计入配额：连续 50 次后生成仍可用', async () => {
    for (let index = 0; index < 50; index += 1) {
      const res = await request(app).get('/api/readings/capacity').query({ targetWords: 200 })
      expect(res.status).toBe(200)
    }

    // 预检打了 50 次，生成的第 1 次不能被挡（这条是 md/22 里前端提的硬要求）
    expect((await badGenerate()).status).toBe(400)
  })

  it('生成接口自己的配额会用完', async () => {
    // 上一条用例已经用掉 1 次，这里再用 1 次就到点
    expect((await badGenerate()).status).toBe(400)

    const blocked = await badGenerate()
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.body.error.details).toEqual({ limit: 2, windowSeconds: 60 })
    // 走 errorHandler，所以和 422 / 500 一样带 requestId（pino-http 生成的是数字）
    expect(blocked.body.requestId).toBeTruthy()

    // 被限的是生成，不是整个 /readings 前缀
    const capacity = await request(app).get('/api/readings/capacity').query({ targetWords: 200 })
    expect(capacity.status).toBe(200)
  })
})
