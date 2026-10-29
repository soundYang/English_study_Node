import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { hashPassword } from '../modules/auth/password.js'

/**
 * 管理员登录限流：5 次失败 / 15 分钟 / IP（md/37 §2.5 / §9）。
 *
 * 单独成文件的原因有两个：
 *   · 需要打开 RATE_LIMIT_ENABLED（setup.js 默认关闭）；
 *   · 「连续失败 6 次」会把同文件里其它输错密码的用例一起打成 429。
 *
 * 另外验证 `skipSuccessfulRequests`：成功登录不占配额，
 * 否则管理员正常用几次就会被自己锁住。
 */
process.env.RATE_LIMIT_ENABLED = 'true'
process.env.ADMIN_USERNAME = 'admin'
process.env.ADMIN_PASSWORD_HASH = await hashPassword('AdminPass123')

const { createApp } = await import('../app.js')

const app = createApp()

const login = (password) =>
  request(app).post('/api/admin/auth/login').send({ username: 'admin', password })

describe('管理员登录限流', () => {
  // 顺序有讲究：成功登录先跑，计数保持 0；后面 5 次失败用完配额，
  // 第 6 次必然被挡。反过来的话（先失败再成功），成功请求本身就会被挡在门外，
  // 测到的就不是 skipSuccessfulRequests 了
  it('成功登录不占失败配额', async () => {
    const res = await login('AdminPass123')

    expect(res.status).toBe(200)
    expect(typeof res.body.token).toBe('string')
  })

  it('5 次失败后第 6 次 → 429 RATE_LIMITED', async () => {
    for (let index = 0; index < 5; index += 1) {
      const res = await login('WrongPass123')

      expect(res.status).toBe(401)
    }

    const blocked = await login('WrongPass123')

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
  })
})
