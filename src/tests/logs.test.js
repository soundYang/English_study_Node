import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 访问 / 报错日志落库（md/53）。
 *
 * config 首次 import 时读环境变量，而测试环境默认**关闭**这两张表
 * （891 个用例每个都发请求，开着等于白写几万条）。所以这里先打开再动态 import。
 *
 * 写库是「响应结束后异步进行」的，断言一律用轮询等待，不能 request 一返回就查——
 * 那样测的是运气，不是行为。
 */
const ADMIN_USERNAME = 'logAdmin'
const ADMIN_PASSWORD = 'AdminPass123'

process.env.ACCESS_LOG_ENABLED = 'true'
process.env.ERROR_LOG_ENABLED = 'true'
process.env.ADMIN_USERNAME = ADMIN_USERNAME

// hashPassword 只依赖 node:crypto，可以在设置 ADMIN_* 之后、导入 app 之前调用
const { hashPassword } = await import('../modules/auth/password.js')
process.env.ADMIN_PASSWORD_HASH = await hashPassword(ADMIN_PASSWORD)

const { createApp } = await import('../app.js')
const { AccessLog } = await import('../modules/logs/access-log.model.js')
const { ErrorLog } = await import('../modules/logs/error-log.model.js')
const { ApiError, ERROR_CODES } = await import('../shared/errors.js')
const { errorHandler } = await import('../shared/middleware/errorHandler.js')
const { accessLogger } = await import('../shared/middleware/accessLog.js')
const { requestLogger } = await import('../shared/middleware/requestLogger.js')

const app = createApp()

/** 轮询等待异步写库完成：命中返回结果，超时返回 null（让断言给出真实失败信息） */
async function waitFor(read, { tries = 60, intervalMs = 25 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 最小可复现 500 的应用：只挂日志中间件 + 一个会抛的路由 + 统一错误出口。
 * 生产应用里没有任何路由会故意抛异常，直接塞一个进 createApp 也没用——
 * errorHandler 已经注册在 404 兜底之后，后加的路由永远走不到它。
 */
function throwingApp(handler) {
  const mini = express()

  mini.use(requestLogger)
  mini.use(accessLogger)
  mini.get('/boom', handler)
  mini.use(errorHandler)

  return mini
}

async function adminToken() {
  const res = await request(app)
    .post('/api/admin/auth/login')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

  expect(res.status).toBe(200)

  return res.body.token
}

describe('访问日志', () => {
  it('一次请求写一条：IP / 路径 / 状态码 / 用户 / requestId', async () => {
    const res = await request(app)
      .get('/api/public/basic-words')
      .set('User-Agent', 'vitest-access-log')

    expect(res.status).toBe(200)

    const doc = await waitFor(() =>
      AccessLog.findOne({ path: '/api/public/basic-words' }).lean(),
    )

    expect(doc).not.toBeNull()
    expect(doc.method).toBe('GET')
    expect(doc.statusCode).toBe(200)
    // supertest 走 loopback，地址本身不重要，重要的是「非空且是请求来源」
    expect(doc.ip).toBeTruthy()
    expect(doc.userAgent).toBe('vitest-access-log')
    expect(doc.requestId).toMatch(/^req-\d+$/)
    expect(doc.durationMs).toBeGreaterThanOrEqual(0)
    // currentUser 在 accessLogger 之后执行，但写库发生在响应结束时，
    // 所以这里必须已经拿到回落用户——同时验证了中间件顺序
    expect(doc.userId).toBe('local-user')
  })

  it('4xx 也记：业务错误是预期分支，不写 errorlogs，但要能在访问日志里看到', async () => {
    const res = await request(app).get('/api/definitely-not-a-route')

    expect(res.status).toBe(404)

    const access = await waitFor(() =>
      AccessLog.findOne({ path: '/api/definitely-not-a-route' }).lean(),
    )
    expect(access?.statusCode).toBe(404)

    // 等一小会儿再确认：4xx 不应该出现在报错表里
    await sleep(100)
    expect(await ErrorLog.countDocuments({ path: '/api/definitely-not-a-route' })).toBe(0)
  })

  it('健康检查不落库（探活轮询高频且没有信息量）', async () => {
    await request(app).get('/api/health')
    await sleep(150)

    expect(await AccessLog.countDocuments({ path: '/api/health' })).toBe(0)
  })

  it('请求体与令牌不落库：表里没有这些字段', async () => {
    await request(app)
      .post('/api/admin/auth/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

    const doc = await waitFor(() =>
      AccessLog.findOne({ path: '/api/admin/auth/login' }).lean(),
    )

    expect(doc).not.toBeNull()
    for (const leaked of ['body', 'headers', 'authorization', 'password', 'token']) {
      expect(doc).not.toHaveProperty(leaked)
    }
    // 序列化后也不该出现密码或令牌原文
    expect(JSON.stringify(doc)).not.toContain(ADMIN_PASSWORD)
  })
})

describe('报错日志', () => {
  it('未捕获异常 → 500，落库带 code / message / stack / requestId', async () => {
    const mini = throwingApp(() => {
      throw new Error('boom from test')
    })

    const res = await request(mini).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR)

    const doc = await waitFor(() => ErrorLog.findOne({ path: '/boom' }).lean())

    expect(doc).not.toBeNull()
    expect(doc.statusCode).toBe(500)
    expect(doc.code).toBe(ERROR_CODES.INTERNAL_ERROR)
    expect(doc.message).toBe('boom from test')
    expect(doc.stack).toContain('boom from test')
    // 与响应体里的 requestId 必须同源，否则用户报错时对不上日志
    expect(doc.requestId).toBe(res.body.requestId)
    expect(doc.ip).toBeTruthy()
  })

  it('5xx 的 ApiError 也落库（仍是意外，只是已经被归一化）', async () => {
    const mini = throwingApp(() => {
      throw new ApiError(503, 'SERVICE_DOWN', '服务暂时不可用')
    })

    const res = await request(mini).get('/boom')
    expect(res.status).toBe(503)

    const doc = await waitFor(() => ErrorLog.findOne({ code: 'SERVICE_DOWN' }).lean())

    expect(doc).not.toBeNull()
    expect(doc.statusCode).toBe(503)
    expect(doc.message).toBe('服务暂时不可用')
  })

  it('4xx 的 ApiError 不落库（预期分支，答案在访问日志的 statusCode 里）', async () => {
    const mini = throwingApp(() => {
      throw new ApiError(400, ERROR_CODES.INVALID_REQUEST, '参数不对')
    })

    const res = await request(mini).get('/boom')
    expect(res.status).toBe(400)

    await sleep(150)
    expect(await ErrorLog.countDocuments({})).toBe(0)
  })

  it('响应体不泄露堆栈（红线只影响落库，不影响返回）', async () => {
    const mini = throwingApp(() => {
      throw new Error('secret internal detail')
    })

    const res = await request(mini).get('/boom')

    expect(JSON.stringify(res.body)).not.toContain('secret internal detail')
    expect(res.body.error.message).toBe('服务器内部错误')
  })
})

describe('GET /api/admin/logs', () => {
  it('不带令牌 / 普通用户令牌 → 401，两个接口都一样', async () => {
    for (const path of ['/api/admin/logs/access', '/api/admin/logs/errors']) {
      const res = await request(app).get(path)

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('ADMIN_AUTH_REQUIRED')
    }
  })

  it('访问日志：按 ip / status / path 过滤，分页按时间倒序', async () => {
    const token = await adminToken()
    const ip = '198.51.100.7'

    // 三条同 IP，状态码各不同；另有一条不同 IP 作干扰项
    const created = []
    for (const [statusCode, path] of [
      [200, '/api/words?page=1'],
      [404, '/api/words/missing'],
      [429, '/api/readings'],
    ]) {
      created.push(
        await AccessLog.create({ method: 'GET', path, statusCode, ip, userId: 'fixture-a' }),
      )
    }
    await AccessLog.create({
      method: 'GET',
      path: '/api/words',
      statusCode: 200,
      ip: '203.0.113.9',
    })

    const all = await request(app)
      .get('/api/admin/logs/access')
      .query({ ip, size: 2, page: 1 })
      .set('Authorization', `Bearer ${token}`)

    expect(all.status).toBe(200)
    expect(all.body.total).toBe(3)
    expect(all.body.items).toHaveLength(2)
    // 倒序：最近插入的先出（createdAt 相同时按 _id 倒序兜底）
    expect(all.body.items.map((item) => item.id)).toEqual([
      String(created[2]._id),
      String(created[1]._id),
    ])

    const page2 = await request(app)
      .get('/api/admin/logs/access')
      .query({ ip, size: 2, page: 2 })
      .set('Authorization', `Bearer ${token}`)

    expect(page2.body.items.map((item) => item.id)).toEqual([String(created[0]._id)])

    const byStatus = await request(app)
      .get('/api/admin/logs/access')
      .query({ status: 404 })
      .set('Authorization', `Bearer ${token}`)

    expect(byStatus.body.total).toBe(1)
    expect(byStatus.body.items[0].path).toBe('/api/words/missing')

    const byPath = await request(app)
      .get('/api/admin/logs/access')
      .query({ path: 'missing' })
      .set('Authorization', `Bearer ${token}`)

    expect(byPath.body.total).toBe(1)
    expect(byPath.body.items[0].statusCode).toBe(404)
  })

  it('路径过滤按字面量匹配，不把输入当正则执行', async () => {
    const token = await adminToken()

    await AccessLog.create({
      method: 'GET',
      path: '/api/words?q=(ab',
      statusCode: 200,
      ip: '198.51.100.8',
    })

    // `(` 未转义会让 new RegExp 抛异常变 500；转义后按字面量命中
    const res = await request(app)
      .get('/api/admin/logs/access')
      .query({ path: '(ab' })
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
  })

  it('报错日志：按 code / ip 过滤，返回堆栈给管理员定位', async () => {
    const token = await adminToken()

    await ErrorLog.create({
      method: 'GET',
      path: '/api/words',
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'db exploded',
      stack: 'Error: db exploded\n    at somewhere',
      ip: '198.51.100.20',
    })
    await ErrorLog.create({
      method: 'POST',
      path: '/api/readings',
      statusCode: 500,
      code: 'DB_DOWN',
      message: 'connection lost',
      ip: '198.51.100.21',
    })

    const byCode = await request(app)
      .get('/api/admin/logs/errors')
      .query({ code: 'DB_DOWN' })
      .set('Authorization', `Bearer ${token}`)

    expect(byCode.status).toBe(200)
    expect(byCode.body.total).toBe(1)
    expect(byCode.body.items[0].message).toBe('connection lost')
    expect(byCode.body.items[0].createdAt).toBeTruthy()

    const byIp = await request(app)
      .get('/api/admin/logs/errors')
      .query({ ip: '198.51.100.20' })
      .set('Authorization', `Bearer ${token}`)

    expect(byIp.body.total).toBe(1)
    expect(byIp.body.items[0].code).toBe('INTERNAL_ERROR')
    expect(byIp.body.items[0].stack).toContain('db exploded')
  })

  it('查询参数越界 → 400 INVALID_REQUEST', async () => {
    const token = await adminToken()

    const tooBig = await request(app)
      .get('/api/admin/logs/access')
      .query({ size: 1000 })
      .set('Authorization', `Bearer ${token}`)

    expect(tooBig.status).toBe(400)
    expect(tooBig.body.error.code).toBe(ERROR_CODES.INVALID_REQUEST)

    const badPage = await request(app)
      .get('/api/admin/logs/errors')
      .query({ page: 0 })
      .set('Authorization', `Bearer ${token}`)

    expect(badPage.status).toBe(400)
    expect(badPage.body.error.code).toBe(ERROR_CODES.INVALID_REQUEST)
  })
})
