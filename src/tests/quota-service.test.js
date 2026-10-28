import { describe, expect, it } from 'vitest'

/**
 * 额度服务（md/35 §6、§11.2）。
 *
 * 这里验证的是「原子性」与「回滚」——都是纯逻辑，不走 HTTP。
 *
 * 和其它开关类用例一样：config 在首次 import 时读环境变量，
 * 所以先改值再动态 import（setup.js 已把开关固定成 false）。
 */
process.env.DAILY_QUOTA_ENABLED = 'true'
process.env.DAILY_QUOTA_ACCOUNT = '3'
process.env.DAILY_QUOTA_DEVICE = '3'
process.env.DAILY_QUOTA_NETWORK = '10'

const { config } = await import('../config/index.js')
const { Quota } = await import('../modules/quota/quota.model.js')
const {
  getQuotaSnapshot,
  quotaDay,
  quotaKeysFor,
  readDeviceId,
  releaseQuota,
  reserveQuota,
} = await import('../modules/quota/quota.service.js')

const DEVICE = 'device-0123456789abcdef'

/** 已登录 + 带设备 ID 的完整身份 */
const identity = {
  user: { dataKey: 'u_quota' },
  deviceId: DEVICE,
  ip: '10.0.0.1',
  userAgent: 'vitest',
  acceptLanguage: 'zh-CN',
}

const keysOf = (who = identity) => Object.fromEntries(
  quotaKeysFor(who).map((item) => [item.scope, item.key]),
)

async function usedOf(key) {
  const doc = await Quota.findOne({ key, day: quotaDay() })
  return doc?.used ?? 0
}

describe('预扣', () => {
  it('连续三次成功，第四次 429 QUOTA_EXCEEDED（账号先满）', async () => {
    for (let round = 1; round <= 3; round += 1) {
      const reservation = await reserveQuota({ identity })

      expect(reservation.keys).toHaveLength(3)
      expect(await usedOf(keysOf().account)).toBe(round)
      expect(await usedOf(keysOf().device)).toBe(round)
    }

    await expect(reserveQuota({ identity })).rejects.toMatchObject({
      status: 429,
      code: 'QUOTA_EXCEEDED',
      details: { scope: 'account', limit: 3, used: 3 },
    })

    // 失败的这一次不能把设备 / 网络也加上去
    expect(await usedOf(keysOf().device)).toBe(3)
    expect(await usedOf(keysOf().network)).toBe(3)
  })

  it('5 个并发预扣恰好放进来 3 个（不能靠先查再改）', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserveQuota({ identity })),
    )

    const ok = results.filter((item) => item.status === 'fulfilled' && item.value)
    expect(ok).toHaveLength(3)
    expect(await usedOf(keysOf().device)).toBe(3)
  })

  it('网络键已满时，账号与设备已经加过的次数要回滚', async () => {
    const keys = keysOf()

    // 先把网络桶填满：这就是「同一出口下别人已经用完了」
    await Quota.create({
      key: keys.network,
      day: quotaDay(),
      used: config.dailyQuotaNetwork,
      expireAt: new Date(Date.now() + 86_400_000),
    })

    await expect(reserveQuota({ identity })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { scope: 'network' },
    })

    // 账号 / 设备先加后减，最终必须回到 0
    expect(await usedOf(keys.account)).toBe(0)
    expect(await usedOf(keys.device)).toBe(0)
  })

  it('同一天不同身份的桶互不影响', async () => {
    const other = { ...identity, user: { dataKey: 'u_other' }, deviceId: 'device-other-0123456789' }

    await reserveQuota({ identity })
    await reserveQuota({ identity: other })

    expect(await usedOf(keysOf().account)).toBe(1)
    expect(await usedOf(keysOf(other).account)).toBe(1)
    expect(await usedOf(keysOf(other).device)).toBe(1)
  })
})

describe('退还', () => {
  it('退还 -1，且永远不减成负数', async () => {
    const reservation = await reserveQuota({ identity })
    expect(await usedOf(keysOf().device)).toBe(1)

    await releaseQuota(reservation)
    expect(await usedOf(keysOf().device)).toBe(0)

    // 重复退还（比如失败回调与取消同时触发）不能让 used 变成 -1
    await releaseQuota(reservation)
    expect(await usedOf(keysOf().device)).toBe(0)
  })
})

describe('快照', () => {
  it('登录用户的主额度是账号，还显示设备与网络两档', async () => {
    await reserveQuota({ identity })

    const snapshot = await getQuotaSnapshot({ identity })

    expect(snapshot.primary).toEqual({ scope: 'account', limit: 3, used: 1, remaining: 2 })
    expect(snapshot.blocking).toBeNull()
    expect(snapshot.breakdown.map((item) => item.scope)).toEqual(['account', 'device', 'network'])
    expect(snapshot.resetAt).toBeTruthy()
  })

  it('未登录时主额度是设备（不会冒出 local-user 账号桶）', async () => {
    const anonymous = { ...identity, user: null }

    await reserveQuota({ identity: anonymous })
    const snapshot = await getQuotaSnapshot({ identity: anonymous })

    expect(snapshot.primary.scope).toBe('device')
    expect(snapshot.breakdown.map((item) => item.scope)).toEqual(['device', 'network'])
    expect(await Quota.countDocuments({ key: 'acct:local-user' })).toBe(0)
  })

  it('任意一档用尽都给 blocking，即使 primary 还有余量', async () => {
    await Quota.create({
      key: keysOf().device,
      day: quotaDay(),
      used: config.dailyQuotaDevice,
      expireAt: new Date(Date.now() + 86_400_000),
    })

    const snapshot = await getQuotaSnapshot({ identity })

    expect(snapshot.primary.remaining).toBe(3) // 账号一次没用
    expect(snapshot.blocking).toMatchObject({ scope: 'device', remaining: 0 })
  })

  it('没有任何使用记录时剩余 = 上限，不会被当成 0', async () => {
    const snapshot = await getQuotaSnapshot({ identity })

    expect(snapshot.primary).toEqual({ scope: 'account', limit: 3, used: 0, remaining: 3 })
  })
})

describe('设备 ID 校验', () => {
  it('UUID 与 base64url 都合法', () => {
    expect(readDeviceId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    )
    expect(readDeviceId('AbCdEf0123456789_-xyzABC')).toBe('AbCdEf0123456789_-xyzABC')
  })

  it('非法值一律当作没传，不抛错', () => {
    expect(readDeviceId('abc')).toBe('') // 太短，没有区分度
    expect(readDeviceId('device id with spaces')).toBe('') // 非法字符
    expect(readDeviceId('a'.repeat(65))).toBe('') // 超长
    expect(readDeviceId(undefined)).toBe('')
    expect(readDeviceId(123)).toBe('')
  })

  it('前后空格会被 trim', () => {
    expect(readDeviceId('  3f2504e0-4f89-11d3-9a0c-0305e82c3301  ')).toBe(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    )
  })
})
