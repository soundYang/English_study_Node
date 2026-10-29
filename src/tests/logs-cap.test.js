import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 日志容量上限（md/53 §11）。
 *
 * TTL 只按时间删，挡不住「短时间被打进几百万条」；这里验证达到行数上限后
 * 会停止写入，而不是把磁盘写满。
 *
 * 上限只能在 config 首次 import 前设定，所以单独一个文件（同 auth-enforced 的做法）。
 * 三类表各留一个很小的上限；cap 状态在进程内缓存，测试按「访问 → 报错 → 登录」
 * 的顺序执行，每个表只会被填满一次。
 */
const ADMIN_USERNAME = 'capAdmin'
const ADMIN_PASSWORD = 'AdminPass123'

process.env.ACCESS_LOG_ENABLED = 'true'
process.env.ACCESS_LOG_MAX_ROWS = '3'
process.env.ERROR_LOG_ENABLED = 'true'
process.env.ERROR_LOG_MAX_ROWS = '2'
process.env.LOGIN_LOG_ENABLED = 'true'
process.env.LOGIN_LOG_MAX_ROWS = '2'
process.env.ADMIN_USERNAME = ADMIN_USERNAME

const { hashPassword } = await import('../modules/auth/password.js')
process.env.ADMIN_PASSWORD_HASH = await hashPassword(ADMIN_PASSWORD)

const { createApp } = await import('../app.js')
const { AccessLog } = await import('../modules/logs/access-log.model.js')
const { ErrorLog } = await import('../modules/logs/error-log.model.js')
const { LoginRecord } = await import('../modules/logs/login-log.model.js')
const { errorHandler } = await import('../shared/middleware/errorHandler.js')
const { accessLogger } = await import('../shared/middleware/accessLog.js')
const { requestLogger } = await import('../shared/middleware/requestLogger.js')

const app = createApp()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只挂日志中间件 + 一个必抛路由 + 统一错误出口 */
function throwingApp() {
  const mini = express()

  mini.use(requestLogger)
  mini.use(accessLogger)
  mini.get('/boom', () => {
    throw new Error('cap test boom')
  })
  mini.use(errorHandler)

  return mini
}

describe('日志容量上限', () => {
  it('访问日志达到上限后停止写入', async () => {
    await AccessLog.create(
      [1, 2, 3].map((index) => ({
        method: 'GET',
        path: `/seed-${index}`,
        statusCode: 200,
        ip: '198.51.100.60',
      })),
    )

    // 成功请求已经不落库（md/53 §12），必须用失败请求才会走到写入路径
    const res = await request(app).get('/api/definitely-not-a-route')
    expect(res.status).toBe(404)

    // 等异步的 count 检查 + 可能的写库完成
    await sleep(300)

    expect(await AccessLog.countDocuments({ path: '/api/definitely-not-a-route' })).toBe(0)
    expect(await AccessLog.countDocuments({})).toBe(3)
  })

  it('报错日志达到上限后停止写入', async () => {
    await ErrorLog.create([
      {
        method: 'GET',
        path: '/seed-a',
        statusCode: 500,
        code: 'SEED_A',
        message: 'a',
        ip: '198.51.100.61',
      },
      {
        method: 'GET',
        path: '/seed-b',
        statusCode: 500,
        code: 'SEED_B',
        message: 'b',
        ip: '198.51.100.61',
      },
    ])

    const res = await request(throwingApp()).get('/boom')
    expect(res.status).toBe(500)

    await sleep(300)

    expect(await ErrorLog.countDocuments({ path: '/boom' })).toBe(0)
    expect(await ErrorLog.countDocuments({})).toBe(2)
  })

  it('登录记录达到上限后停止写入', async () => {
    await LoginRecord.create([
      {
        userId: 'fixture-cap-a',
        username: 'CapA',
        role: 'user',
        success: true,
        ip: '198.51.100.62',
      },
      {
        username: 'CapB',
        role: 'user',
        success: false,
        ip: '198.51.100.62',
      },
    ])

    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

    // 登录本身不受影响：日志写不进去，业务照常成功
    expect(res.status).toBe(200)

    await sleep(300)

    expect(await LoginRecord.countDocuments({ role: 'admin' })).toBe(0)
    expect(await LoginRecord.countDocuments({})).toBe(2)
  })
})
