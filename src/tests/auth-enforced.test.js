import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * AUTH_ENFORCED=true：必须带令牌才能碰业务接口（md/33 §7.3）。
 *
 * config 在首次 import 时读取环境变量，所以这里和 rate-limit.test.js 一样：
 * 先改值，再动态 import。setup.js 已经把开关固定成 false（默认的上线形态），
 * 这个文件验证的是「开关打开之后」的那一套。
 */
process.env.AUTH_ENFORCED = 'true'

const { createApp } = await import('../app.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')

const app = createApp()
const PASSWORD = 'Passw0rd1'

async function registerAndGetToken() {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username: 'EnforcedUser',
    password: PASSWORD,
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)
  return res.body.token
}

describe('强制鉴权', () => {
  it('业务接口不带令牌 → 401 AUTH_REQUIRED', async () => {
    const paths = ['/api/words', '/api/basic-words', '/api/readings']

    for (const path of paths) {
      const res = await request(app).get(path)

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('AUTH_REQUIRED')
      expect(res.body.error.message).toBe('请先登录')
    }
  })

  it('伪造令牌 → 401（不会回落到 local-user）', async () => {
    const res = await request(app)
      .get('/api/words')
      .set('Authorization', 'Bearer sess_forged_token')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('有效令牌 → 200', async () => {
    const token = await registerAndGetToken()

    const res = await request(app).get('/api/words').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(0)
  })

  it('公开接口不受影响：健康检查、验证码、登录都还能调', async () => {
    const health = await request(app).get('/api/health')
    const captcha = await request(app).post('/api/auth/captcha').send()

    expect(health.status).toBe(200)
    expect(captcha.status).toBe(200)
    expect(captcha.body.svg).toContain('<svg')
  })

  it('注册在未登录时可调（否则没人能登录）', async () => {
    const token = await registerAndGetToken()
    expect(token).toMatch(/^sess_/)
  })

  it('令牌过期后重新变成 401', async () => {
    const token = await registerAndGetToken()
    expect((await request(app).get('/api/words').set('Authorization', `Bearer ${token}`)).status).toBe(200)

    // 直接把这个用户的会话改成已过期。用 service 层改，避免依赖 TTL 线程
    const { Session } = await import('../modules/auth/session.model.js')
    await Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    const after = await request(app).get('/api/words').set('Authorization', `Bearer ${token}`)
    expect(after.status).toBe(401)
  })
})
