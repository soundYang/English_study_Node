import { beforeAll, describe, expect, it } from 'vitest'

import { Captcha } from '../modules/auth/captcha.model.js'
import { Session } from '../modules/auth/session.model.js'
import { User } from '../modules/auth/user.model.js'

/**
 * 三张鉴权表的约束（md/33 §3 / S1）。
 *
 * 唯一索引不是「好看」，是「重名注册返回 409」的最后一道保险——
 * service 里的先查再建挡不住并发，两个请求同时查不到就能同时插进去。
 * 所以这里必须真的把索引建出来再测，不能只测 Schema 字段。
 */

beforeAll(async () => {
  // setup.js 只给 Word / Reading 建了索引；新表在这里补上
  await Promise.all([User.syncIndexes(), Session.syncIndexes(), Captcha.syncIndexes()])
})

function makeUser(overrides = {}) {
  return {
    username: 'Sound',
    usernameLower: 'sound',
    passwordHash: 'scrypt$16384$8$1$YWJj$YWJj',
    dataKey: 'local-user',
    ...overrides,
  }
}

describe('users 的唯一索引', () => {
  it('dataKey 不能重复', async () => {
    await User.create(makeUser({ dataKey: 'local-user', usernameLower: 'a' }))
    const err = await User.create(makeUser({ dataKey: 'local-user', usernameLower: 'b' })).catch(
      (error) => error,
    )

    expect(err.code).toBe(11000)
  })

  it('usernameLower 不能重复（大小写不同也算重名）', async () => {
    await User.create(makeUser({ username: 'Sound', usernameLower: 'sound' }))
    const err = await User.create(
      makeUser({ username: 'SOUND', usernameLower: 'sound', dataKey: 'u_2' }),
    ).catch((error) => error)

    expect(err.code).toBe(11000)
  })

  it('两个用户都不填手机号不会撞唯一键', async () => {
    // 这条是 partialFilterExpression 的回归：换成 sparse 索引的话，
    // default: null 会把 null 真的写进库，第二个用户直接 11000，注册 500
    await User.create(makeUser({ dataKey: 'u_1', usernameLower: 'a', phone: null }))
    await expect(
      User.create(makeUser({ dataKey: 'u_2', usernameLower: 'b', phone: null })),
    ).resolves.toBeTruthy()
  })

  it('手机号重复会被拒', async () => {
    await User.create(makeUser({ dataKey: 'u_1', usernameLower: 'a', phone: '13800138000' }))
    const err = await User.create(
      makeUser({ dataKey: 'u_2', usernameLower: 'b', phone: '13800138000' }),
    ).catch((error) => error)

    expect(err.code).toBe(11000)
  })
})

describe('users 的字段长度', () => {
  it('昵称超过 20 字被拒', async () => {
    const err = await User.create(makeUser({ nickname: '很'.repeat(21) })).catch((error) => error)
    expect(err.name).toBe('ValidationError')
  })

  it('签名超过 60 字被拒', async () => {
    const err = await User.create(makeUser({ signature: '少'.repeat(61) })).catch((error) => error)
    expect(err.name).toBe('ValidationError')
  })

  it('用户名超过 20 字被拒', async () => {
    const err = await User.create(makeUser({ username: 'a'.repeat(21) })).catch((error) => error)
    expect(err.name).toBe('ValidationError')
  })
})

describe('TTL 索引', () => {
  it('sessions.expiresAt 挂了 expireAfterSeconds: 0', async () => {
    const indexes = await Session.collection.indexes()
    expect(indexes.some((index) => index.expireAfterSeconds === 0)).toBe(true)
  })

  it('captchas.expiresAt 挂了 expireAfterSeconds: 0', async () => {
    const indexes = await Captcha.collection.indexes()
    expect(indexes.some((index) => index.expireAfterSeconds === 0)).toBe(true)
  })
})

describe('sessions', () => {
  /**
   * ttlSeconds 是滑动续期的依据（「还剩不到一半就续满」），不存就没法知道续多久：
   * 1 天和 30 天的会话在某一时刻的 expiresAt 看起来是一样的。
   */
  const makeSession = (userId, overrides = {}) => ({
    userId,
    tokenHash: 'hash-a',
    expiresAt: new Date(Date.now() + 60_000),
    ttlSeconds: 24 * 60 * 60,
    ...overrides,
  })

  it('tokenHash 不能重复', async () => {
    const user = await User.create(makeUser())

    await Session.create(makeSession(user._id))
    const err = await Session.create(makeSession(user._id)).catch((error) => error)

    expect(err.code).toBe(11000)
  })

  it('缺 ttlSeconds 被拒（续期逻辑依赖它）', async () => {
    const user = await User.create(makeUser())
    const err = await Session.create({
      userId: user._id,
      tokenHash: 'hash-c',
      expiresAt: new Date(Date.now() + 60_000),
    }).catch((error) => error)

    expect(err.name).toBe('ValidationError')
  })

  it('userAgent 超过 200 字被拒', async () => {
    const user = await User.create(makeUser())
    const err = await Session.create(
      makeSession(user._id, { tokenHash: 'hash-b', userAgent: 'm'.repeat(201) }),
    ).catch((error) => error)

    expect(err.name).toBe('ValidationError')
  })
})
