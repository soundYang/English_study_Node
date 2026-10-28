import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { hashToken, resetLoginFailures } from '../modules/auth/auth.service.js'
import { createCaptcha } from '../modules/auth/captcha.service.js'
import { Session } from '../modules/auth/session.model.js'
import { User } from '../modules/auth/user.model.js'

/**
 * 个人中心（md/33 §6.1、§4.4）。
 *
 * setup.js 固定 AUTH_ENFORCED=false，这里是**故意**的：个人中心在没有打开开关时
 * 也必须要求真登录，否则「改昵称」会改到那个虚拟的 local-user 上。
 */

const app = createApp()
const PASSWORD = 'Passw0rd1'
const NEW_PASSWORD = 'NewPassw0rd'
const DAY_MS = 24 * 60 * 60 * 1000

async function register(overrides = {}) {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username: 'ProfileUser',
    password: PASSWORD,
    captchaId,
    captchaCode: 'AB3D',
    ...overrides,
  })

  expect(res.status).toBe(201)
  return res.body
}

async function login(usernameOrPhone, password = PASSWORD) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ usernameOrPhone, password })
  expect(res.status).toBe(200)
  return res.body
}

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)

const getProfile = (token) => authed(request(app).get('/api/profile'), token)
const patchProfile = (token, body) => authed(request(app).patch('/api/profile'), token).send(body)
const changePassword = (token, body) =>
  authed(request(app).post('/api/profile/password'), token).send(body)

beforeEach(() => {
  resetLoginFailures()
})

describe('GET /api/profile', () => {
  it('没有令牌 → 401，即使 AUTH_ENFORCED=false', async () => {
    const res = await request(app).get('/api/profile')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('伪造令牌 → 401', async () => {
    const res = await getProfile('sess_forged_token')
    expect(res.status).toBe(401)
  })

  it('有效令牌 → 返回当前用户，且不含 dataKey / passwordHash / usernameLower', async () => {
    const { token, user } = await register()

    const res = await getProfile(token)

    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({
      id: user.id,
      username: 'ProfileUser',
      nickname: 'ProfileUser',
      signature: '',
      phone: null,
      createdAt: res.body.user.createdAt,
    })
    expect(res.body.user).not.toHaveProperty('dataKey')
    expect(res.body.user).not.toHaveProperty('passwordHash')
    expect(res.body.user).not.toHaveProperty('usernameLower')
  })
})

describe('PATCH /api/profile', () => {
  it('改昵称：返回新值，库里同步更新', async () => {
    const { token } = await register()

    const res = await patchProfile(token, { nickname: '山间读者' })

    expect(res.status).toBe(200)
    expect(res.body.user.nickname).toBe('山间读者')
    expect(res.body.user.username).toBe('ProfileUser')

    const stored = await User.findOne({ usernameLower: 'profileuser' })
    expect(stored.nickname).toBe('山间读者')
  })

  it('改签名：trim 后落库，空串表示清空', async () => {
    const { token } = await register()

    const first = await patchProfile(token, { signature: '  每天读一篇  ' })
    expect(first.status).toBe(200)
    expect(first.body.user.signature).toBe('每天读一篇')

    const cleared = await patchProfile(token, { signature: '' })
    expect(cleared.status).toBe(200)
    expect(cleared.body.user.signature).toBe('')
  })

  it('没传的字段保持原值（PATCH 语义）', async () => {
    const { token } = await register()
    await patchProfile(token, { nickname: '甲', signature: '乙' })

    const res = await patchProfile(token, { nickname: '丙' })

    expect(res.body.user).toMatchObject({ nickname: '丙', signature: '乙' })
  })

  it('空对象也放行，什么都不改', async () => {
    const { token } = await register()

    const res = await patchProfile(token, {})

    expect(res.status).toBe(200)
    expect(res.body.user.nickname).toBe('ProfileUser')
  })

  it('昵称为空 / 超过 20 字 → 400，field 指向 nickname', async () => {
    const { token } = await register()

    const empty = await patchProfile(token, { nickname: '   ' })
    expect(empty.status).toBe(400)
    expect(empty.body.error.field).toBe('nickname')

    const tooLong = await patchProfile(token, { nickname: '名'.repeat(21) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error.field).toBe('nickname')
  })

  it('签名超过 60 字 → 400，field 指向 signature', async () => {
    const { token } = await register()

    const res = await patchProfile(token, { signature: '签'.repeat(61) })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('signature')
  })

  it('用户名不可通过 PATCH 修改（多余字段被丢弃）', async () => {
    const { token } = await register()

    const res = await patchProfile(token, { username: 'hacker', nickname: '正常昵称' })

    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe('ProfileUser')
    expect(await User.exists({ usernameLower: 'hacker' })).toBeNull()
  })

  it('没有令牌 → 401', async () => {
    const res = await request(app).patch('/api/profile').send({ nickname: '谁' })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/profile/password', () => {
  it('没有令牌 → 401', async () => {
    const res = await request(app)
      .post('/api/profile/password')
      .send({ oldPassword: PASSWORD, newPassword: NEW_PASSWORD })

    expect(res.status).toBe(401)
  })

  it('旧密码错 → 400（不能是 401：前端见到 401 会清 token 把人登出）', async () => {
    const { token } = await register()

    const res = await changePassword(token, { oldPassword: 'Wrong1234', newPassword: NEW_PASSWORD })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('oldPassword')
    expect(res.body.error.message).toBe('当前密码不正确')
  })

  it('新密码不符合规则 → 400，field 指向 newPassword', async () => {
    const { token } = await register()

    const tooShort = await changePassword(token, { oldPassword: PASSWORD, newPassword: 'Ab1' })
    expect(tooShort.status).toBe(400)
    expect(tooShort.body.error.field).toBe('newPassword')

    const noDigit = await changePassword(token, { oldPassword: PASSWORD, newPassword: 'abcdefgh' })
    expect(noDigit.status).toBe(400)
    expect(noDigit.body.error.field).toBe('newPassword')
  })

  it('新旧密码相同 → 400', async () => {
    const { token } = await register()

    const res = await changePassword(token, { oldPassword: PASSWORD, newPassword: PASSWORD })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('newPassword')
    expect(res.body.error.message).toBe('新密码不能与当前密码相同')
  })

  it('成功后：旧密码登不进去，新密码可以', async () => {
    const { token } = await register()

    const res = await changePassword(token, { oldPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ usernameOrPhone: 'ProfileUser', password: PASSWORD })
    expect(oldLogin.status).toBe(401)

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ usernameOrPhone: 'ProfileUser', password: NEW_PASSWORD })
    expect(newLogin.status).toBe(200)
  })

  it('成功后：当前会话保留并续满，其它设备全部失效', async () => {
    const first = await register()
    const second = await login('ProfileUser')
    const third = await login('ProfileUser')
    expect(await Session.countDocuments()).toBe(3)

    // 把第三个会话的到期时间压到 1 分钟，验证改密码会把它续满
    await Session.updateOne(
      { tokenHash: hashToken(third.token) },
      { $set: { expiresAt: new Date(Date.now() + 60_000) } },
    )
    const res = await changePassword(third.token, {
      oldPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(res.status).toBe(200)

    expect(await Session.countDocuments()).toBe(1)

    // 当前这台设备还能用
    expect((await getProfile(third.token)).status).toBe(200)

    // 其它两台立刻 401
    expect((await getProfile(first.token)).status).toBe(401)
    expect((await getProfile(second.token)).status).toBe(401)

    // 当前会话被续满（1 天）
    const kept = await Session.findOne({})
    expect(kept.expiresAt.getTime() - Date.now()).toBeGreaterThan(DAY_MS - 60_000)
  })

  it('改密码不动别人的会话', async () => {
    const mine = await register()
    await register({ username: 'OtherUser' })
    expect(await Session.countDocuments()).toBe(2)

    await changePassword(mine.token, { oldPassword: PASSWORD, newPassword: NEW_PASSWORD })

    // 另一个人注册时那一条会话还在
    expect(await Session.countDocuments()).toBe(2)
  })
})
