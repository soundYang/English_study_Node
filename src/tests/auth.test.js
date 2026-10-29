import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { AppMeta } from '../modules/auth/appmeta.model.js'
import { parseBearer } from '../modules/auth/auth.middleware.js'
import {
  LEGACY_DATA_KEY,
  mayClaimLegacyDataKey,
  resetLoginFailures,
  resolveSession,
  SESSION_TTL_SECONDS,
} from '../modules/auth/auth.service.js'
import { createCaptcha } from '../modules/auth/captcha.service.js'
import { Session } from '../modules/auth/session.model.js'
import { User } from '../modules/auth/user.model.js'
import { Word } from '../modules/words/word.model.js'

/**
 * 注册 / 登录 / 会话的集成用例（md/33 §6、§8）。
 *
 * setup.js 固定 AUTH_ENFORCED=false，所以这里跑的是**上线第一阶段**：
 * 带了令牌按令牌走，没带令牌仍然回落 local-user，老前端不会全站 401。
 * 「开关打开后必须 401」在 auth-enforced.test.js。
 */

const app = createApp()
const PASSWORD = 'Passw0rd1'
const DAY_MS = SESSION_TTL_SECONDS.standard * 1000

/** 直接造一张已知答案的验证码；`text` 参数只给测试用，路由从不传 */
async function captchaPayload(text = 'AB3D') {
  const { captchaId } = await createCaptcha({ text })
  return { captchaId, captchaCode: text }
}

async function registerRequest(overrides = {}) {
  const body = {
    username: 'SoundYang',
    password: PASSWORD,
    ...(await captchaPayload()),
    ...overrides,
  }

  return request(app).post('/api/auth/register').send(body)
}

async function registerUser(overrides = {}) {
  const res = await registerRequest(overrides)
  expect(res.status).toBe(201)
  return res.body
}

const login = (body) => request(app).post('/api/auth/login').send(body)

/** 不带令牌 → 走 DEFAULT_USER_ID；带令牌 → 走该用户的 dataKey */
function getWords(token) {
  const req = request(app).get('/api/words')
  return token ? req.set('Authorization', `Bearer ${token}`) : req
}

beforeEach(() => {
  // 失败计数是进程内 Map，不会随集合清空一起消失
  resetLoginFailures()
})

describe('POST /api/auth/captcha', () => {
  it('返回 svg 与 captchaId，svg 里没有可读文字', async () => {
    const res = await request(app).post('/api/auth/captcha').send()

    expect(res.status).toBe(200)
    expect(res.body.captchaId).toMatch(/^[0-9a-f]{24}$/)
    expect(res.body.svg).toContain('<svg')
    // 只要出现 <text>，答案就是可复制、可解析的（md/33 §5.2）
    expect(res.body.svg).not.toContain('<text')
    expect(res.body.expiresIn).toBe(300)
  })
})

describe('POST /api/auth/register', () => {
  it('成功注册 201，直接返回令牌与用户信息，不含任何敏感字段', async () => {
    const res = await registerRequest()

    expect(res.status).toBe(201)
    expect(res.body.token).toMatch(/^sess_[A-Za-z0-9_-]{40,}$/)
    expect(res.body.user).toMatchObject({
      username: 'SoundYang',
      nickname: 'SoundYang',
      signature: '',
      phone: null,
    })
    expect(res.body.user).not.toHaveProperty('dataKey')
    expect(res.body.user).not.toHaveProperty('passwordHash')
    expect(res.body.user).not.toHaveProperty('usernameLower')

    // 不勾「记住账号」是 1 天
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(DAY_MS - 60_000)
    expect(ttl).toBeLessThanOrEqual(DAY_MS)
  })

  it('库里存的是密码哈希和令牌哈希，不是原文', async () => {
    const { body } = await registerRequest()

    const user = await User.findOne({ usernameLower: 'soundyang' })
    expect(user.passwordHash).toMatch(/^scrypt\$/)
    expect(user.passwordHash).not.toContain(PASSWORD)

    const sessions = await Session.find({})
    expect(sessions).toHaveLength(1)
    expect(sessions[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sessions[0].tokenHash).not.toBe(body.token)
  })

  it('白名单内的账号接管 local-user 的历史数据，其余账号拿到独立数据域（md/45 M1）', async () => {
    await registerUser({ username: 'FirstUser' })
    await registerUser({ username: 'SecondUser' })

    const first = await User.findOne({ usernameLower: 'firstuser' })
    const second = await User.findOne({ usernameLower: 'seconduser' })

    expect(first.dataKey).toBe(LEGACY_DATA_KEY)
    expect(second.dataKey).toMatch(/^u_/)
    expect(second.dataKey).not.toBe(first.dataKey)
    expect(await AppMeta.countDocuments({ _id: 'legacy-owner' })).toBe(1)
  })

  it('白名单外的账号即使先注册，也抢不到 local-user 的历史数据（md/45 M1）', async () => {
    await Word.create({ userId: LEGACY_DATA_KEY, word: 'abandon', meaning: '放弃', source: 'manual' })

    const intruder = await registerUser({ username: 'Intruder' })
    const user = await User.findOne({ usernameLower: 'intruder' })

    expect(user.dataKey).toMatch(/^u_/)
    // 名额没被消耗：真正的站主之后注册仍能接管
    expect(await AppMeta.countDocuments({ _id: 'legacy-owner' })).toBe(0)

    const words = await request(app)
      .get('/api/words')
      .set('Authorization', `Bearer ${intruder.token}`)

    expect(words.body.total).toBe(0)
  })

  it('白名单判定：空名单谁都不许，忽略大小写与首尾空格', () => {
    expect(mayClaimLegacyDataKey('SoundYang', [])).toBe(false)
    expect(mayClaimLegacyDataKey('', [''])).toBe(false)
    expect(mayClaimLegacyDataKey('SoundYang', ['soundyang'])).toBe(true)
    expect(mayClaimLegacyDataKey(' soundyang ', ['soundyang'])).toBe(true)
  })

  it('验证码错误 → 400 CAPTCHA_INVALID，不建用户也不占 legacy 名额', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })

    const res = await request(app).post('/api/auth/register').send({
      username: 'SoundYang',
      password: PASSWORD,
      captchaId,
      captchaCode: 'ZZZZ',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('CAPTCHA_INVALID')
    expect(res.body.error.field).toBe('captchaCode')
    expect(await User.countDocuments()).toBe(0)
    expect(await AppMeta.countDocuments()).toBe(0)
  })

  it('同一张验证码不能用第二次', async () => {
    const captcha = await captchaPayload()
    const payload = { username: 'SoundYang', password: PASSWORD, ...captcha }

    expect((await request(app).post('/api/auth/register').send(payload)).status).toBe(201)

    const again = await request(app)
      .post('/api/auth/register')
      .send({ ...payload, username: 'OtherUser' })
    expect(again.status).toBe(400)
    expect(again.body.error.code).toBe('CAPTCHA_EXPIRED')
  })

  it('验证码答案大小写不敏感', async () => {
    const res = await registerRequest({ captchaCode: 'ab3d' })
    expect(res.status).toBe(201)
  })

  it('缺验证码 → 400 INVALID_REQUEST', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'SoundYang', password: PASSWORD })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
  })

  it('用户名被占用（大小写不敏感）→ 409 AUTH_USERNAME_TAKEN', async () => {
    await registerUser({ username: 'SoundYang' })

    const res = await registerRequest({ username: 'soundyang' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('AUTH_USERNAME_TAKEN')
    expect(res.body.error.field).toBe('username')
  })

  it('手机号被占用 → 409 AUTH_PHONE_TAKEN', async () => {
    await registerUser({ username: 'FirstUser', phone: '13800001111' })

    const res = await registerRequest({ username: 'SecondUser', phone: '13800001111' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('AUTH_PHONE_TAKEN')
  })

  it('不带手机号的用户可以有很多个（phone 唯一索引不能误伤 null）', async () => {
    await registerUser({ username: 'FirstUser' })
    await registerUser({ username: 'SecondUser' })
    await registerUser({ username: 'ThirdUser' })

    expect(await User.countDocuments()).toBe(3)
  })

  it('弱密码、非法用户名 → 400，且不消耗验证码以外的东西', async () => {
    const weak = await registerRequest({ password: 'abcdefgh' })
    expect(weak.status).toBe(400)
    expect(weak.body.error.field).toBe('password')

    const badName = await registerRequest({ username: '中文名' })
    expect(badName.status).toBe(400)
    expect(badName.body.error.field).toBe('username')

    expect(await User.countDocuments()).toBe(0)
  })
})

describe('POST /api/auth/login', () => {
  it('用户名登录成功（大小写不敏感），并新开一个会话', async () => {
    await registerUser()

    const res = await login({ usernameOrPhone: 'soundyang', password: PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body.token).toMatch(/^sess_/)
    expect(res.body.user.username).toBe('SoundYang')
    expect(res.body.user).not.toHaveProperty('passwordHash')
    expect(await Session.countDocuments()).toBe(2)
  })

  it('手机号也能登录', async () => {
    await registerUser({ phone: '13800001111' })

    const res = await login({ usernameOrPhone: '13800001111', password: PASSWORD })
    expect(res.status).toBe(200)
  })

  it('记住我 → 30 天', async () => {
    await registerUser()

    const res = await login({ usernameOrPhone: 'SoundYang', password: PASSWORD, rememberMe: true })
    expect(res.status).toBe(200)

    const ttl = new Date(res.body.expiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(SESSION_TTL_SECONDS.remember * 1000 - 60_000)
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS.remember * 1000)
  })

  it('密码错与用户不存在返回同一个错误码和文案（防账号枚举）', async () => {
    await registerUser()

    const wrong = await login({ usernameOrPhone: 'SoundYang', password: 'Wrong1234' })
    const missing = await login({ usernameOrPhone: 'NobodyHere', password: 'Wrong1234' })

    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    expect(wrong.body.error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(missing.body.error).toMatchObject({
      code: wrong.body.error.code,
      message: wrong.body.error.message,
    })
  })

  it('连续 5 次失败后必须带验证码，带对了仍然能登录', async () => {
    await registerUser()

    for (let i = 0; i < 5; i += 1) {
      const res = await login({ usernameOrPhone: 'SoundYang', password: 'Wrong1234' })
      expect(res.status).toBe(401)
    }

    const blocked = await login({ usernameOrPhone: 'SoundYang', password: PASSWORD })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.code).toBe('CAPTCHA_REQUIRED')

    const ok = await login({
      usernameOrPhone: 'SoundYang',
      password: PASSWORD,
      ...(await captchaPayload()),
    })
    expect(ok.status).toBe(200)
  })

  it('成功登录会清零失败计数（4 次失败后仍不必带验证码）', async () => {
    await registerUser()

    for (let i = 0; i < 4; i += 1) {
      await login({ usernameOrPhone: 'SoundYang', password: 'Wrong1234' })
    }
    expect((await login({ usernameOrPhone: 'SoundYang', password: PASSWORD })).status).toBe(200)

    const after = await login({ usernameOrPhone: 'SoundYang', password: 'Wrong1234' })
    expect(after.status).toBe(401)
    expect(after.body.error.code).toBe('AUTH_INVALID_CREDENTIALS')
  })

  it('失败计数按标识符隔离：别人的失败不影响我', async () => {
    await registerUser({ username: 'FirstUser' })
    await registerUser({ username: 'SoundYang' })

    for (let i = 0; i < 5; i += 1) {
      await login({ usernameOrPhone: 'FirstUser', password: 'Wrong1234' })
    }

    const mine = await login({ usernameOrPhone: 'SoundYang', password: PASSWORD })
    expect(mine.status).toBe(200)
  })
})

describe('POST /api/auth/logout', () => {
  it('令牌立即作废，只删当前这一条', async () => {
    const first = await registerUser()
    const second = await login({ usernameOrPhone: 'SoundYang', password: PASSWORD })
    expect(await Session.countDocuments()).toBe(2)

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${first.token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(await Session.countDocuments()).toBe(1)
    expect(await resolveSession(first.token)).toBeNull()
    expect(await resolveSession(second.body.token)).not.toBeNull()
  })

  it('幂等：不带令牌或令牌无效也返回 200', async () => {
    const anonymous = await request(app).post('/api/auth/logout').send()
    const bogus = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer sess_not_a_real_token')

    expect(anonymous.status).toBe(200)
    expect(bogus.status).toBe(200)
  })
})

describe('令牌 → 数据域（AUTH_ENFORCED=false）', () => {
  it('带令牌读自己的数据，无令牌仍回落到 local-user', async () => {
    await Word.create({ userId: LEGACY_DATA_KEY, word: 'abandon', meaning: '放弃', source: 'manual' })

    const legacy = await registerUser({ username: 'LegacyOwner' })
    const other = await registerUser({ username: 'OtherUser' })

    const anonymous = await getWords()
    expect(anonymous.status).toBe(200)
    expect(anonymous.body.total).toBe(1)

    const owner = await getWords(legacy.token)
    expect(owner.status).toBe(200)
    expect(owner.body.total).toBe(1)

    // 新用户的数据域是空的：别人的词不会跟着令牌串过来
    const stranger = await getWords(other.token)
    expect(stranger.status).toBe(200)
    expect(stranger.body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      counts: { all: 0, mastered: 0, learning: 0, new: 0 },
    })
  })

  it('令牌无效时不会 401，仍然回落 local-user', async () => {
    const res = await getWords('sess_expired_or_forged')

    expect(res.status).toBe(200)
  })
})

describe('会话生命周期', () => {
  it('过期会话解析为 null（不等 TTL 线程清理）', async () => {
    const { token } = await registerUser()
    await Session.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    expect(await resolveSession(token)).toBeNull()
  })

  it('用户被删除后令牌失效，并顺手清掉会话', async () => {
    const { token } = await registerUser()
    await User.deleteMany({})

    expect(await resolveSession(token)).toBeNull()
    expect(await Session.countDocuments()).toBe(0)
  })

  it('剩余不足一半时滑动续期，并前移 lastSeenAt', async () => {
    const { token } = await registerUser()

    await Session.updateOne(
      {},
      {
        $set: {
          expiresAt: new Date(Date.now() + 60_000),
          lastSeenAt: new Date(Date.now() - 120_000),
        },
      },
    )

    expect(await resolveSession(token)).not.toBeNull()

    const session = await Session.findOne({})
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(DAY_MS - 60_000)
    expect(session.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000)
  })

  it('剩余充足时不续期（避免每个请求一次写库）', async () => {
    const { token } = await registerUser()
    const far = new Date(Date.now() + DAY_MS - 60_000)
    await Session.updateOne({}, { $set: { expiresAt: far } })

    await resolveSession(token)

    const session = await Session.findOne({})
    expect(session.expiresAt.getTime()).toBe(far.getTime())
  })

  it('同一用户最多保留 10 个会话，超出踢掉最旧的', async () => {
    await registerUser()

    for (let i = 0; i < 10; i += 1) {
      const res = await login({ usernameOrPhone: 'SoundYang', password: PASSWORD })
      expect(res.status).toBe(200)
    }

    expect(await Session.countDocuments()).toBe(10)
  })
})

describe('parseBearer', () => {
  it('只认 Bearer 方案，大小写不敏感', () => {
    expect(parseBearer('Bearer sess_abc')).toBe('sess_abc')
    expect(parseBearer('bearer sess_abc')).toBe('sess_abc')
    expect(parseBearer('  Bearer   sess_abc  ')).toBe('sess_abc')
  })

  it('畸形或超长的头一律当作未登录', () => {
    expect(parseBearer(undefined)).toBe('')
    expect(parseBearer('')).toBe('')
    expect(parseBearer('Token sess_abc')).toBe('')
    expect(parseBearer('Bearer')).toBe('')
    expect(parseBearer('Bearer sess_abc extra')).toBe('')
    expect(parseBearer(`Bearer ${'a'.repeat(201)}`)).toBe('')
  })
})
