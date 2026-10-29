import { randomBytes } from 'node:crypto'

import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 自备 Key 的接口（md/43 §5 / §11.2）。
 *
 * 上游校验打桩：导入 / 复核两处的唯一外部依赖是 DeepSeek `/models`，
 * 真打会把测试变成「网络好不好」的不稳定用例。
 * 限流单独放在 ai-key-rate-limit.test.js —— 这里整套限流是关的，
 * 否则同一文件里后面的用例会被前面累计的计数打成 429。
 */

const { verifyDeepSeekKey } = vi.hoisted(() => ({ verifyDeepSeekKey: vi.fn() }))

vi.mock('../modules/ai-keys/ai-key.provider.js', () => ({ verifyDeepSeekKey }))

const SECRET = randomBytes(32).toString('base64')

process.env.USER_API_KEY_ENABLED = 'true'
process.env.USER_API_KEY_SECRET = SECRET

const { createApp } = await import('../app.js')
const { encryptSecret, fingerprintKey } = await import('../modules/ai-keys/ai-key.crypto.js')
const { UserApiKey } = await import('../modules/ai-keys/ai-key.model.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')
const { User } = await import('../modules/auth/user.model.js')
const { userApiKeyInvalid, userApiKeyVerifyFailed } = await import('../shared/errors.js')

const app = createApp()
const PASSWORD = 'Passw0rd1'
const VALID_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'

async function register() {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })
  const res = await request(app).post('/api/auth/register').send({
    username: 'ApiKeyUser',
    password: PASSWORD,
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)
  return res.body
}

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)
const getKey = (token) => authed(request(app).get('/api/profile/api-key'), token)
const putKey = (token, body) =>
  authed(request(app).put('/api/profile/api-key'), token).send(body)
const deleteKey = (token) => authed(request(app).delete('/api/profile/api-key'), token)
const verifyKey = (token) => authed(request(app).post('/api/profile/api-key/verify'), token)

async function dataKeyOf(username = 'apikeyuser') {
  return (await User.findOne({ usernameLower: username }).lean()).dataKey
}

async function seedKey(userId, { apiKey = VALID_KEY, status = 'active', cipher = null } = {}) {
  return UserApiKey.create({
    userId,
    provider: 'deepseek',
    cipher: cipher ?? encryptSecret(apiKey),
    last4: apiKey.slice(-4),
    fingerprint: fingerprintKey(apiKey),
    status,
  })
}

beforeEach(() => {
  verifyDeepSeekKey.mockReset()
})

describe('鉴权', () => {
  it('四个接口未登录一律 401', async () => {
    const results = await Promise.all([
      request(app).get('/api/profile/api-key'),
      request(app).put('/api/profile/api-key').send({ apiKey: VALID_KEY }),
      request(app).delete('/api/profile/api-key'),
      request(app).post('/api/profile/api-key/verify'),
    ])

    for (const res of results) expect(res.status).toBe(401)
  })
})

describe('GET /api/profile/api-key', () => {
  it('没导入过 → key: null，功能可用', async () => {
    const { token } = await register()

    const res = await getKey(token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      enabled: true,
      supportedProviders: ['deepseek'],
      key: null,
    })
  })

  it('已导入 → 只回掩码，绝不回完整 Key / cipher / fingerprint', async () => {
    const { token } = await register()
    await seedKey(await dataKeyOf())

    const res = await getKey(token)

    expect(res.status).toBe(200)
    expect(res.body.key).toMatchObject({
      provider: 'deepseek',
      maskedKey: 'sk-****6789',
      status: 'active',
    })
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain(VALID_KEY)
    expect(raw).not.toContain('cipher')
    expect(raw).not.toContain('fingerprint')
  })

  it('密文解不开时 status 报 unreadable，但不落库', async () => {
    const { token } = await register()
    // kid 对不上任何一把主密钥：等价于「换过 Secret 但旧值没保留」
    await seedKey(await dataKeyOf(), { cipher: 'v1.deadbeef.AAAA.AAAA.AAAA' })

    const res = await getKey(token)

    expect(res.body.key.status).toBe('unreadable')
    expect((await UserApiKey.findOne({})).status).toBe('active')
  })
})

describe('PUT /api/profile/api-key', () => {
  it('格式不对 → 400，field=apiKey，不调上游也不落库', async () => {
    const { token } = await register()

    for (const apiKey of ['', 'sk-short', 'https://evil.example.com/key', 'sk-' + 'x'.repeat(200)]) {
      const res = await putKey(token, { apiKey })

      expect(res.status).toBe(400)
      expect(res.body.error.field).toBe('apiKey')
    }

    expect(verifyDeepSeekKey).not.toHaveBeenCalled()
    expect(await UserApiKey.countDocuments({})).toBe(0)
  })

  it('provider 只支持 deepseek', async () => {
    const { token } = await register()

    const res = await putKey(token, { provider: 'openai', apiKey: VALID_KEY })

    expect(res.status).toBe(400)
    expect(res.body.error.field).toBe('provider')
  })

  it('上游 401 → 400 USER_API_KEY_INVALID，已有的 Key 原样保留', async () => {
    const { token } = await register()
    const userId = await dataKeyOf()
    await seedKey(userId)
    const before = await UserApiKey.findOne({ userId }).lean()

    verifyDeepSeekKey.mockRejectedValueOnce(userApiKeyInvalid())
    const res = await putKey(token, { apiKey: 'sk-replacementkey0000000000000000' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('USER_API_KEY_INVALID')

    const after = await UserApiKey.findOne({ userId }).lean()
    expect(after.cipher).toBe(before.cipher)
    expect(after.last4).toBe(before.last4)
  })

  it('上游超时 / 5xx → 502 USER_API_KEY_VERIFY_FAILED，不落库', async () => {
    const { token } = await register()

    verifyDeepSeekKey.mockRejectedValueOnce(userApiKeyVerifyFailed())
    const res = await putKey(token, { apiKey: VALID_KEY })

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('USER_API_KEY_VERIFY_FAILED')
    expect(await UserApiKey.countDocuments({})).toBe(0)
  })

  it('成功 → 返回与 GET 同结构，库里是密文', async () => {
    const { token } = await register()

    verifyDeepSeekKey.mockResolvedValueOnce(true)
    const res = await putKey(token, { apiKey: VALID_KEY })

    expect(res.status).toBe(200)
    expect(res.body.key).toMatchObject({
      provider: 'deepseek',
      maskedKey: 'sk-****6789',
      status: 'active',
    })
    expect(res.body.key.lastVerifiedAt).toBeTruthy()

    const stored = await UserApiKey.findOne({}).lean()
    expect(stored.cipher.startsWith('v1.')).toBe(true)
    expect(stored.cipher).not.toContain(VALID_KEY)
    expect(stored.last4).toBe('6789')
  })

  it('重复导入 → 仍只有一行，updatedAt 刷新', async () => {
    const { token } = await register()

    verifyDeepSeekKey.mockResolvedValue(true)
    await putKey(token, { apiKey: VALID_KEY })
    const first = await UserApiKey.findOne({}).lean()

    await new Promise((resolve) => setTimeout(resolve, 5))
    const res = await putKey(token, { apiKey: 'sk-secondkey000000000000000000000' })

    expect(res.status).toBe(200)
    expect(await UserApiKey.countDocuments({})).toBe(1)

    const second = await UserApiKey.findOne({}).lean()
    expect(second.last4).toBe('0000')
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime())
  })

})

describe('DELETE /api/profile/api-key', () => {
  it('删除后回免费路径；再删一次仍 200', async () => {
    const { token } = await register()
    await seedKey(await dataKeyOf())

    const first = await deleteKey(token)
    expect(first.status).toBe(200)
    expect(first.body.key).toBeNull()
    expect(await UserApiKey.countDocuments({})).toBe(0)

    const second = await deleteKey(token)
    expect(second.status).toBe(200)
  })
})

describe('POST /api/profile/api-key/verify', () => {
  it('成功 → status=active 并刷新 lastVerifiedAt', async () => {
    const { token } = await register()
    const userId = await dataKeyOf()
    await seedKey(userId, { status: 'invalid' })

    verifyDeepSeekKey.mockResolvedValueOnce(true)
    const res = await verifyKey(token)

    expect(res.status).toBe(200)
    expect(res.body.key.status).toBe('active')
    expect(res.body.key.lastVerifiedAt).toBeTruthy()

    const stored = await UserApiKey.findOne({ userId }).lean()
    expect(stored.status).toBe('active')
    expect(stored.lastVerifiedAt).toBeInstanceOf(Date)
  })

  it('上游 401 → 400 且 status 置 invalid（Key 保留）', async () => {
    const { token } = await register()
    const userId = await dataKeyOf()
    await seedKey(userId)

    verifyDeepSeekKey.mockRejectedValueOnce(userApiKeyInvalid())
    const res = await verifyKey(token)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('USER_API_KEY_INVALID')
    expect((await UserApiKey.findOne({ userId }).lean()).status).toBe('invalid')
  })

  it('网络失败 → 502，status 不变', async () => {
    const { token } = await register()
    const userId = await dataKeyOf()
    await seedKey(userId, { status: 'active' })

    verifyDeepSeekKey.mockRejectedValueOnce(userApiKeyVerifyFailed())
    const res = await verifyKey(token)

    expect(res.status).toBe(502)
    expect((await UserApiKey.findOne({ userId }).lean()).status).toBe('active')
  })

  it('没有可解密的 Key → 409 USER_API_KEY_MISSING', async () => {
    const { token } = await register()

    const res = await verifyKey(token)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('USER_API_KEY_MISSING')
  })
})
