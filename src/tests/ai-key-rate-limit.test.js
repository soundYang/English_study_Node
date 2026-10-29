import { randomBytes } from 'node:crypto'

import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

/**
 * 自备 Key 写操作的限流（md/43 §5 / §11.2）。
 *
 * 单独成文件：限流实例在模块加载时构造，开着跑的计数会跨用例累计，
 * 放进 ai-key-routes.test.js 会把后面所有用例打成 429。
 * 同一个 IP 上 PUT / DELETE / verify **共用一个桶**。
 */

const { verifyDeepSeekKey } = vi.hoisted(() => ({ verifyDeepSeekKey: vi.fn() }))

vi.mock('../modules/ai-keys/ai-key.provider.js', () => ({ verifyDeepSeekKey }))

process.env.USER_API_KEY_ENABLED = 'true'
process.env.USER_API_KEY_SECRET = randomBytes(32).toString('base64')
process.env.RATE_LIMIT_ENABLED = 'true'
process.env.RATE_LIMIT_API_KEY = '5'

const { createApp } = await import('../app.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')

const app = createApp()

describe('PUT / DELETE / verify 共用 5 次/分钟', () => {
  it('第 6 次写操作 → 429 RATE_LIMITED', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })
    const registered = await request(app).post('/api/auth/register').send({
      username: 'RateKeyUser',
      password: 'Passw0rd1',
      captchaId,
      captchaCode: 'AB3D',
    })
    expect(registered.status).toBe(201)

    const token = registered.body.token
    verifyDeepSeekKey.mockResolvedValue(true)

    // 前 5 次：3 次 PUT（每次换一把 Key）+ 1 次 verify + 1 次 DELETE
    for (let index = 0; index < 3; index += 1) {
      const res = await request(app)
        .put('/api/profile/api-key')
        .set('Authorization', `Bearer ${token}`)
        .send({ apiKey: `sk-ratelimit${index}000000000000000000` })

      expect(res.status).toBe(200)
    }

    const verified = await request(app)
      .post('/api/profile/api-key/verify')
      .set('Authorization', `Bearer ${token}`)
    expect(verified.status).toBe(200)

    const deleted = await request(app)
      .delete('/api/profile/api-key')
      .set('Authorization', `Bearer ${token}`)
    expect(deleted.status).toBe(200)

    const blocked = await request(app)
      .put('/api/profile/api-key')
      .set('Authorization', `Bearer ${token}`)
      .send({ apiKey: 'sk-ratelimit-blocked000000000000' })

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    // 被挡下的请求没走到上游校验
    expect(verifyDeepSeekKey).toHaveBeenCalledTimes(4)
  })

  it('GET 不占写操作桶', async () => {
    // 上一个用例把桶用完了；GET 只读自己的文档，不该被 429
    const { captchaId } = await createCaptcha({ text: 'AB3D' })
    const registered = await request(app).post('/api/auth/register').send({
      username: 'RateKeyReader',
      password: 'Passw0rd1',
      captchaId,
      captchaCode: 'AB3D',
    })

    const res = await request(app)
      .get('/api/profile/api-key')
      .set('Authorization', `Bearer ${registered.body.token}`)

    expect(res.status).toBe(200)
  })
})
