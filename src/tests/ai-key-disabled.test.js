import { randomBytes } from 'node:crypto'

import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 功能关闭时的接口行为（md/43 §5.1 / §5.5）。
 *
 * 单独成文件：`config` 是冻结对象，开关只能在模块加载前用环境变量决定。
 * 规则：
 *   GET  → 200 + `enabled: false`（前端整块隐藏，不要让个人中心报错）
 *   写操作 → 503 USER_API_KEY_DISABLED
 */

process.env.USER_API_KEY_ENABLED = 'false'
process.env.USER_API_KEY_SECRET = randomBytes(32).toString('base64')

const { createApp } = await import('../app.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')

const app = createApp()

async function register() {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username: 'KeyDisabledUser',
    password: 'Passw0rd1',
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)
  return res.body.token
}

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)

describe('USER_API_KEY_ENABLED=false', () => {
  it('GET 仍 200，enabled=false、key=null', async () => {
    const token = await register()

    const res = await authed(request(app).get('/api/profile/api-key'), token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      enabled: false,
      supportedProviders: ['deepseek'],
      key: null,
    })
  })

  it('PUT / DELETE / verify 一律 503 USER_API_KEY_DISABLED', async () => {
    const token = await register()

    const results = await Promise.all([
      authed(request(app).put('/api/profile/api-key'), token).send({
        apiKey: 'sk-disabled000000000000000000000',
      }),
      authed(request(app).delete('/api/profile/api-key'), token),
      authed(request(app).post('/api/profile/api-key/verify'), token),
    ])

    for (const res of results) {
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('USER_API_KEY_DISABLED')
    }
  })
})
