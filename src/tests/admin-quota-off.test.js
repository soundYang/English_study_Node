import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { hashPassword } from '../modules/auth/password.js'

/**
 * `DAILY_QUOTA_ENABLED=false` 时的额度口径（md/37 §3.6 / §12 坑 3）。
 *
 * 开关关着，库里根本没有 `acct:` 桶。此时显示「剩余 3 次」会让管理员
 * 以为用户还能用 3 次，实际生成毫不受限——必须显示「未启用」（null）。
 *
 * 单独成文件：config 读环境变量的时机在首次 import。
 */
const ADMIN_USERNAME = 'testAdmin'
const ADMIN_PASSWORD = 'AdminPass123'

process.env.ADMIN_USERNAME = ADMIN_USERNAME
process.env.ADMIN_PASSWORD_HASH = await hashPassword(ADMIN_PASSWORD)
process.env.DAILY_QUOTA_ENABLED = 'false'

const { createApp } = await import('../app.js')
const { User } = await import('../modules/auth/user.model.js')

const app = createApp()

async function adminToken() {
  const res = await request(app)
    .post('/api/admin/auth/login')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

  expect(res.status).toBe(200)
  return res.body.token
}

describe('额度开关关闭时的台账', () => {
  it('列表：enabled=false，limit / used / remaining 全为 null', async () => {
    await User.create({
      username: 'NoQuota',
      usernameLower: 'noquota',
      passwordHash: await hashPassword('Passw0rd1'),
      dataKey: 'dk_noquota',
    })

    const token = await adminToken()
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.items[0].quota).toEqual({
      enabled: false,
      limit: null,
      used: null,
      remaining: null,
      day: expect.any(String),
    })
  })

  it('详情同样不把额度说成 3 次', async () => {
    await User.create({
      username: 'NoQuota2',
      usernameLower: 'noquota2',
      passwordHash: await hashPassword('Passw0rd1'),
      dataKey: 'dk_noquota2',
    })

    const token = await adminToken()
    const res = await request(app)
      .get('/api/admin/users/dk_noquota2')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.quota.enabled).toBe(false)
    expect(res.body.quota.remaining).toBeNull()
  })
})
