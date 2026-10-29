import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 生成限流：身份桶 + IP 安全桶（md/55 §4.9）。
 *
 * 设备 ID 是客户端可控的：身份桶负责 NAT 后的公平性，IP 桶负责挡住
 * 轮换设备 ID 的脚本。两条桶都关闭成功请求跳过——失败的生成也花了模型调用。
 */
process.env.RATE_LIMIT_ENABLED = 'true'
process.env.RATE_LIMIT_GENERATE = '2'
process.env.RATE_LIMIT_GENERATE_IP = '60'

const {
  createGenerateIpLimiter,
  createGenerateLimiter,
  generateRateLimitKey,
} = await import('../shared/middleware/rateLimit.js')
const { errorHandler } = await import('../shared/middleware/errorHandler.js')

function miniApp(limiter) {
  const mini = express()
  mini.get('/x', limiter, (req, res) => res.json({ ok: true }))
  mini.use(errorHandler)
  return mini
}

const get = (app, deviceId = null) => {
  const req = request(app).get('/x')
  return deviceId ? req.set('X-Device-Id', deviceId) : req
}

const DEVICE_A = 'device-aaaaaaaaaaaa'
const DEVICE_B = 'device-bbbbbbbbbbbb'

describe('身份桶', () => {
  it('账号优先，其次设备，最后回落到 IP', () => {
    expect(generateRateLimitKey({
      auth: { user: { dataKey: 'user-1' } },
      get: () => DEVICE_A,
      ip: '127.0.0.1',
    })).toBe('acct:user-1')

    expect(generateRateLimitKey({
      auth: null,
      get: (name) => (name === 'X-Device-Id' ? DEVICE_A : ''),
      ip: '127.0.0.1',
    })).toBe(`dev:${DEVICE_A}`)

    expect(generateRateLimitKey({
      auth: null,
      get: () => '',
      ip: '127.0.0.1',
    })).toMatch(/^ip:/)
  })

  it('NAT 后两台设备各用各的桶，互不影响', async () => {
    const app = miniApp(createGenerateLimiter({ limit: 2, enabled: true }))

    expect((await get(app, DEVICE_A)).status).toBe(200)
    expect((await get(app, DEVICE_A)).status).toBe(200)

    const blockedA = await get(app, DEVICE_A)
    expect(blockedA.status).toBe(429)
    expect(blockedA.body.error.code).toBe('RATE_LIMITED')

    // 同一 IP 的另一台设备还有自己的 2 次
    expect((await get(app, DEVICE_B)).status).toBe(200)
  })

  it('没有设备 ID / 账号时按 IP 共用桶', async () => {
    const app = miniApp(createGenerateLimiter({ limit: 2, enabled: true }))

    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(429)
  })
})

describe('IP 安全桶', () => {
  it('无论设备 ID 怎么换，同一 IP 超过额度仍是 429', async () => {
    const app = miniApp(createGenerateIpLimiter({ limit: 2, enabled: true }))

    expect((await get(app, DEVICE_A)).status).toBe(200)
    expect((await get(app, DEVICE_B)).status).toBe(200)
    expect((await get(app, 'device-cccccccccccc')).status).toBe(429)
  })
})
