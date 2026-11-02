import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { hashPassword } from '../modules/auth/password.js'

/**
 * 用户反馈（md/37 §5.1 / §5.2 / §9）。
 *
 * 覆盖三件事：
 *   · 长度边界与每日上限（防刷库）；
 *   · 用户侧不要求登录，能拿到身份就存快照；
 *   · 管理端列表不带正文全文，只有 excerpt。
 */
const ADMIN_USERNAME = 'testAdmin'
const ADMIN_PASSWORD = 'AdminPass123'
const DEVICE_ID = 'feedback-device-0001'

process.env.ADMIN_USERNAME = ADMIN_USERNAME
process.env.ADMIN_PASSWORD_HASH = await hashPassword(ADMIN_PASSWORD)

const { createApp } = await import('../app.js')
const { AdminAudit } = await import('../modules/admin/admin-audit.model.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')
const { Feedback } = await import('../modules/feedback/feedback.model.js')
const { FEEDBACK_IP_DAILY_LIMIT } = await import('../modules/feedback/feedback.service.js')
const { User } = await import('../modules/auth/user.model.js')

const app = createApp()

let adminTokenCache = null

// 集合在每个用例后被清空，管理员会话也在其中
beforeEach(() => {
  adminTokenCache = null
})

async function adminToken() {
  if (adminTokenCache) return adminTokenCache

  const res = await request(app)
    .post('/api/admin/auth/login')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

  expect(res.status).toBe(200)
  adminTokenCache = res.body.token
  return adminTokenCache
}

async function adminRequest(method, path) {
  return request(app)[method](path).set('Authorization', `Bearer ${await adminToken()}`)
}

async function registerAndGetToken({ phone = null } = {}) {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username: 'FeedbackUser',
    password: 'Passw0rd1',
    // 注册接口的 phone 只接受字符串；null 会被判成格式错误
    ...(phone ? { phone } : {}),
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)

  const user = await User.findOne({ username: 'FeedbackUser' }).lean()
  return { token: res.body.token, user }
}

function submit(body, { token, deviceId = DEVICE_ID } = {}) {
  let req = request(app)
    .post('/api/feedback')
    .set('X-Device-Id', deviceId)
    .send(body)

  if (token) req = req.set('Authorization', `Bearer ${token}`)

  return req
}

const validBody = (content) => ({ category: 'bug', content })

describe('POST /api/feedback', () => {
  it('少于 10 个字 → 400 FEEDBACK_TOO_SHORT', async () => {
    const res = await submit(validBody('太短了'))

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('FEEDBACK_TOO_SHORT')
    expect(res.body.error.field).toBe('content')
  })

  it('超过 2000 个字 → 400 FEEDBACK_TOO_LONG', async () => {
    const res = await submit(validBody('啊'.repeat(2001)))

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('FEEDBACK_TOO_LONG')
  })

  it('正常提交 201，状态 open，并存下用户快照', async () => {
    const { token, user } = await registerAndGetToken({ phone: '13800000000' })

    const res = await submit(
      {
        category: 'bug',
        content: '生成到一半一直停在 60%，刷新也没用',
        contact: '微信 xxx',
        page: '/generating',
      },
      { token },
    )

    expect(res.status).toBe(201)
    expect(res.body.status).toBe('open')
    expect(res.body.id).toMatch(/^[0-9a-f]{24}$/)

    const doc = await Feedback.findById(res.body.id).lean()
    expect(doc).toMatchObject({
      userId: user.dataKey,
      username: 'FeedbackUser',
      category: 'bug',
      status: 'open',
      contact: '微信 xxx',
      page: '/generating',
    })
    // md/45 §10.4：手机号只存 users 一处，反馈里不留快照
    expect(doc.phone).toBeUndefined()
  })

  it('同一设备一天第 6 条 → 429', async () => {
    for (let index = 0; index < 5; index += 1) {
      const res = await submit(validBody(`这是第 ${index + 1} 条测试反馈内容`))

      expect(res.status).toBe(201)
    }

    const blocked = await submit(validBody('这是第 6 条测试反馈内容'))

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.body.error.details.scope).toBe('feedback')
  })

  it('换一台设备不受影响', async () => {
    for (let index = 0; index < 5; index += 1) {
      await submit(validBody(`第 ${index + 1} 条反馈内容`))
    }

    const other = await submit(validBody('这是另一台设备提交的反馈'), {
      deviceId: 'feedback-device-0002',
    })

    expect(other.status).toBe(201)
  })
})

describe('管理端反馈接口', () => {
  async function seedFeedback() {
    const { token, user } = await registerAndGetToken()

    const res = await submit(
      {
        category: 'content',
        content: `这篇文章太难了：${'很'.repeat(100)}`,
      },
      { token },
    )

    expect(res.status).toBe(201)

    return { id: res.body.id, user }
  }

  it('列表只给 excerpt，不带正文全文', async () => {
    await seedFeedback()

    const res = await adminRequest('get', '/api/admin/feedback')

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)

    const item = res.body.items[0]
    expect(item.content).toBeUndefined()
    expect(item.reply).toBeUndefined()
    expect(item.excerpt.length).toBeLessThanOrEqual(81)
    expect(item.excerpt.endsWith('…')).toBe(true)
  })

  it('按状态 / 分类筛选', async () => {
    await seedFeedback()

    const open = await adminRequest('get', '/api/admin/feedback?status=open')
    const content = await adminRequest('get', '/api/admin/feedback?category=content')
    const closed = await adminRequest('get', '/api/admin/feedback?status=closed')

    expect(open.body.total).toBe(1)
    expect(content.body.total).toBe(1)
    expect(closed.body.total).toBe(0)
  })

  it('详情给正文全文', async () => {
    const { id } = await seedFeedback()

    const res = await adminRequest('get', `/api/admin/feedback/${id}`)

    expect(res.status).toBe(200)
    expect(res.body.content).toContain('这篇文章太难了')
  })

  it('看反馈详情同样留审计（md/45 §10.1）：详情里有完整手机号', async () => {
    const { id } = await seedFeedback()

    await adminRequest('get', `/api/admin/feedback/${id}`)

    const audit = await AdminAudit.findOne({ action: 'feedback.detail', target: id }).lean()

    expect(audit).not.toBeNull()
    expect(audit.admin).toBe(ADMIN_USERNAME)
    expect(audit.requestId).toMatch(/^req-[0-9a-z]+-\d+$/)
  })

  it('列表打码手机号与联系方式，详情才给完整值（md/45 M6）', async () => {
    const { token } = await registerAndGetToken({ phone: '13800000000' })

    const created = await submit(
      {
        category: 'bug',
        content: '打码用例：列表里不应该看到完整手机号',
        contact: '13800000000',
      },
      { token },
    )
    expect(created.status).toBe(201)

    const list = await adminRequest('get', '/api/admin/feedback')
    const item = list.body.items.find((row) => row.id === created.body.id)

    // 一次翻页 20 条，列表不能直接把手机号交出去
    expect(item.phone).toBe('138****0000')
    expect(item.contact).toBe('138****0000')

    const detail = await adminRequest('get', `/api/admin/feedback/${created.body.id}`)

    // 详情是客服真正联系用户的入口，给完整值
    expect(detail.body.phone).toBe('13800000000')
    expect(detail.body.contact).toBe('13800000000')
  })

  it('手机号现查：用户改号后详情跟着变，文档里没有副本（md/45 §10.4）', async () => {
    const { token, user } = await registerAndGetToken({ phone: '13800000000' })
    const created = await submit(validBody('改号用例：提交后把手机号换掉'), { token })

    await User.updateOne({ dataKey: user.dataKey }, { $set: { phone: '13900001111' } })

    const detail = await adminRequest('get', `/api/admin/feedback/${created.body.id}`)

    expect(detail.body.phone).toBe('13900001111')
    // 快照会让管理端一直看到旧号，所以这张表里根本不该有 phone
    expect((await Feedback.findById(created.body.id).lean()).phone).toBeUndefined()
  })

  it('用户注销后，反馈里查不到手机号（不残留 PII）', async () => {
    const { token, user } = await registerAndGetToken({ phone: '13800000000' })
    const created = await submit(validBody('注销用例：删号后不应再有手机号'), { token })

    await User.deleteOne({ dataKey: user.dataKey })

    const detail = await adminRequest('get', `/api/admin/feedback/${created.body.id}`)
    const list = await adminRequest('get', '/api/admin/feedback')

    expect(detail.body.phone).toBeNull()
    expect(list.body.items.find((row) => row.id === created.body.id).phone).toBeNull()
  })

  it('回复后 status=replied，repliedAt / repliedBy 写入', async () => {
    const { id } = await seedFeedback()

    const res = await request(app)
      .patch(`/api/admin/feedback/${id}`)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .send({ status: 'replied', reply: '已调整难度，请重试' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('replied')
    expect(res.body.reply).toBe('已调整难度，请重试')
    expect(res.body.repliedAt).toBeTruthy()
    expect(res.body.repliedBy).toBe(ADMIN_USERNAME)
  })

  it('标记 replied 但没写回复 → 400', async () => {
    const { id } = await seedFeedback()

    const res = await request(app)
      .patch(`/api/admin/feedback/${id}`)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .send({ status: 'replied' })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('reply')
  })

  it('关闭反馈；已关闭的还能再回复', async () => {
    const { id } = await seedFeedback()

    const closed = await request(app)
      .patch(`/api/admin/feedback/${id}`)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .send({ status: 'closed' })
    expect(closed.status).toBe(200)
    expect(closed.body.status).toBe('closed')

    const reopened = await request(app)
      .patch(`/api/admin/feedback/${id}`)
      .set('Authorization', `Bearer ${await adminToken()}`)
      .send({ status: 'replied', reply: '补充一句' })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe('replied')
  })

  it('不存在的反馈 → 404 FEEDBACK_NOT_FOUND', async () => {
    const notFound = await adminRequest('get', '/api/admin/feedback/66f000000000000000000000')
    const malformed = await adminRequest('get', '/api/admin/feedback/not-an-id')

    for (const res of [notFound, malformed]) {
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('FEEDBACK_NOT_FOUND')
    }
  })
})

describe('IP 桶兜底（md/45 M3）', () => {
  it('轮换设备 ID 也挡得住：同一 IP 第 21 条 429', async () => {
    for (let index = 0; index < FEEDBACK_IP_DAILY_LIMIT; index += 1) {
      const res = await submit(validBody(`轮换设备第 ${index + 1} 条反馈内容`), {
        deviceId: `rotating-device-${String(index).padStart(4, '0')}`,
      })

      // 每次都换设备 ID，设备档永远数到 1，只有 IP 档能拦住
      expect(res.status).toBe(201)
    }

    const blocked = await submit(validBody('第 21 条应该被 IP 桶挡住'), {
      deviceId: 'rotating-device-final',
    })

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.body.error.details).toMatchObject({
      scope: 'feedback',
      limit: FEEDBACK_IP_DAILY_LIMIT,
    })
  })
})
