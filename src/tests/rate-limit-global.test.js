import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 全局兜底限流（md/45 M5）。
 *
 * 单独一个文件的原因：`RATE_LIMIT_GLOBAL` 在这里被压到 5，而计数器是按 IP 的，
 * 同进程里的所有请求共用同一个桶——混在别的用例里会把它们一起打成 429。
 * setup.js 默认关闭限流，所以必须在 config 被导入之前改环境变量（动态 import）。
 */
process.env.RATE_LIMIT_ENABLED = 'true'
process.env.RATE_LIMIT_GLOBAL = '5'

const { createApp } = await import('../app.js')

const app = createApp()

describe('全局兜底限流', () => {
  it('额度内不拦，超出后 429 RATE_LIMITED', async () => {
    for (let index = 0; index < 5; index += 1) {
      const res = await request(app).get('/api/health')

      expect(res.status).toBe(200)
    }

    const blocked = await request(app).get('/api/health')

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.body.error.details).toMatchObject({ limit: 5, windowSeconds: 60 })
  })

  it('被拦的请求也带 requestId：前端报障仍能对上日志', async () => {
    const blocked = await request(app).get('/api/does-not-exist')

    expect(blocked.status).toBe(429)
    expect(blocked.body.requestId).toMatch(/^req-[0-9a-z]+-\d+$/)
  })
})
