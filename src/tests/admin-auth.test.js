import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { hashPassword } from '../modules/auth/password.js'

/**
 * 管理员鉴权（md/37 §2 / §9）。
 *
 * config 首次 import 时读环境变量，所以先设置再动态 import（同 auth-enforced.test.js）。
 * 登录限流单独放 admin-rate-limit.test.js：本文件需要「多次输错」的用例，
 * 开着限流会把它们打成 429。
 */
const ADMIN_USERNAME = 'admin'
const ADMIN_PASSWORD = 'AdminPass123'

process.env.ADMIN_USERNAME = ADMIN_USERNAME
process.env.ADMIN_PASSWORD_HASH = await hashPassword(ADMIN_PASSWORD)

const { createApp } = await import('../app.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')
const { hashToken, SESSION_TTL_SECONDS } = await import('../modules/auth/auth.service.js')
const { AdminSession } = await import('../modules/admin/admin.model.js')

const app = createApp()

const login = (body) => request(app).post('/api/admin/auth/login').send(body)

async function adminToken() {
  const res = await login({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  expect(res.status).toBe(200)
  return res.body.token
}

async function userToken() {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username: 'NormalUser',
    password: 'Passw0rd1',
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)
  return res.body.token
}

describe('POST /api/admin/auth/login', () => {
  it('账号密码正确 → 令牌 + 12 小时有效期', async () => {
    const res = await login({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

    expect(res.status).toBe(200)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.token.length).toBeGreaterThan(32)

    const ttl = new Date(res.body.expiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(11.9 * 60 * 60 * 1000)
    expect(ttl).toBeLessThan(12.1 * 60 * 60 * 1000)
  })

  it('只存 sha256，库里没有令牌原文', async () => {
    const token = await adminToken()
    const rows = await AdminSession.find({}).lean()

    expect(rows).toHaveLength(1)
    expect(rows[0].tokenHash).toBe(hashToken(token))
    expect(rows[0].tokenHash).not.toBe(token)
  })

  it('用户名错 / 密码错都是 401 ADMIN_AUTH_FAILED，不区分', async () => {
    const wrongUser = await login({ username: 'someoneElse', password: ADMIN_PASSWORD })
    const wrongPass = await login({ username: ADMIN_USERNAME, password: 'WrongPass123' })

    for (const res of [wrongUser, wrongPass]) {
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('ADMIN_AUTH_FAILED')
      expect(res.body.error.message).toBe('账号或密码不正确')
    }
  })
})

describe('GET /api/admin/auth/me', () => {
  it('带令牌返回账号与过期时间', async () => {
    const token = await adminToken()
    const res = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.username).toBe(ADMIN_USERNAME)
  })

  it('不带令牌 / 伪造令牌 → 401 ADMIN_AUTH_REQUIRED', async () => {
    const noToken = await request(app).get('/api/admin/auth/me')
    const fake = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', 'Bearer made-up-token')

    for (const res of [noToken, fake]) {
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('ADMIN_AUTH_REQUIRED')
    }
  })

  it('过期的令牌立即 401（TTL 清理有延迟，不能只看查得到）', async () => {
    const token = 'expired-admin-token-0123456789'
    await AdminSession.create({
      username: ADMIN_USERNAME,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 1000),
    })

    const res = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('ADMIN_AUTH_REQUIRED')
  })
})

describe('两种令牌互不通用', () => {
  it('用户令牌打管理端 → 401 ADMIN_AUTH_REQUIRED', async () => {
    const token = await userToken()
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('ADMIN_AUTH_REQUIRED')
  })

  it('管理员令牌打用户侧 → 401 AUTH_REQUIRED', async () => {
    const token = await adminToken()
    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })
})

describe('POST /api/admin/auth/logout', () => {
  it('登出后同一令牌立即失效', async () => {
    const token = await adminToken()

    const res = await request(app)
      .post('/api/admin/auth/logout')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const me = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)
    expect(me.status).toBe(401)
  })

  it('登出不要求令牌有效（幂等）', async () => {
    const res = await request(app).post('/api/admin/auth/logout')

    expect(res.status).toBe(200)
  })
})

describe('会话有效期常量', () => {
  it('用户会话是 1 天 / 30 天，管理员只有 12 小时', async () => {
    const { ADMIN_TOKEN_TTL_SECONDS } = await import('../modules/admin/admin.service.js')

    expect(ADMIN_TOKEN_TTL_SECONDS).toBe(12 * 60 * 60)
    expect(ADMIN_TOKEN_TTL_SECONDS).toBeLessThan(SESSION_TTL_SECONDS.standard)
  })
})
