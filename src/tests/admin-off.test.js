import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 未配置管理员账号时，`/api/admin/*` 整体不存在（md/37 §2.1 / §9）。
 *
 * 显式把两个变量设成空串：开发机 `.env` 里一旦配了管理员，
 * dotenv 会把它带进测试进程，这个文件就测不到「没配置」的形态了。
 */
process.env.ADMIN_USERNAME = ''
process.env.ADMIN_PASSWORD_HASH = ''

const { createApp } = await import('../app.js')

const app = createApp()

describe('管理端未配置', () => {
  it('任何 /api/admin/* 都是 404，不是 401', async () => {
    const paths = [
      ['get', '/api/admin/auth/me'],
      ['post', '/api/admin/auth/login'],
      ['get', '/api/admin/users'],
      ['get', '/api/admin/overview'],
      ['get', '/api/admin/feedback'],
    ]

    for (const [method, path] of paths) {
      const res = await request(app)[method](path)

      // 路由没挂载 → 落到全局 404 兜底；不是「接口在但未授权」
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    }
  })

  it('用户侧接口不受影响', async () => {
    const health = await request(app).get('/api/health')
    const quota = await request(app).get('/api/quota')

    expect(health.status).toBe(200)
    expect(quota.status).toBe(200)
  })
})
