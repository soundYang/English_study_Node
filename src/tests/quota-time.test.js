import { describe, expect, it } from 'vitest'

import { nextResetAt, quotaDay, quotaExpireAt } from '../modules/quota/quota.service.js'

/**
 * 额度的时间口径（md/35 §4.4）。
 *
 * 两个必须成立的性质：
 *   1. 按**北京时间**分桶，不是服务器时区、也不是 UTC；
 *   2. 重置点 = 北京时间次日 0 点，且跨过它之后 day 一定变了。
 *
 * 用固定的 UTC 时刻断言，不依赖运行环境的 TZ：容器里跑 UTC、开发机跑东八区，
 * 结果必须一致。
 */

describe('quotaDay（北京时间自然日）', () => {
  it('北京 23:59:59 仍算当天', () => {
    // 2026-10-29T15:59:59Z = 北京 2026-10-29 23:59:59
    expect(quotaDay(new Date('2026-10-29T15:59:59.000Z'))).toBe('2026-10-29')
  })

  it('北京 00:00:00 进入新的一天', () => {
    // 2026-10-29T16:00:00Z = 北京 2026-10-30 00:00:00
    expect(quotaDay(new Date('2026-10-29T16:00:00.000Z'))).toBe('2026-10-30')
  })

  it('UTC 日期与北京日期不同的时段按北京算', () => {
    // 2026-10-29T20:00:00Z：UTC 还是 29 日，北京已经是 30 日早上 4 点
    expect(quotaDay(new Date('2026-10-29T20:00:00.000Z'))).toBe('2026-10-30')
  })

  it('跨年也正确', () => {
    // 2026-12-31T16:00:00Z = 北京 2027-01-01 00:00:00
    expect(quotaDay(new Date('2026-12-31T16:00:00.000Z'))).toBe('2027-01-01')
  })
})

describe('nextResetAt（北京时间次日 0 点）', () => {
  it('白天时指向当天结束后的 0 点', () => {
    const reset = nextResetAt(new Date('2026-10-29T04:00:00.000Z')) // 北京 12:00
    expect(reset.toISOString()).toBe('2026-10-29T16:00:00.000Z')
  })

  it('刚到 0 点时指向第二天的 0 点，不是「现在」', () => {
    const reset = nextResetAt(new Date('2026-10-29T16:00:00.000Z')) // 北京 30 日 0 点整
    expect(reset.toISOString()).toBe('2026-10-30T16:00:00.000Z')
  })

  it('重置点永远在当前时刻之后，且那一刻的 day 已经变了', () => {
    const now = new Date('2026-10-29T09:30:00.000Z')
    const reset = nextResetAt(now)

    expect(reset.getTime()).toBeGreaterThan(now.getTime())
    expect(quotaDay(new Date(reset.getTime() - 1))).toBe(quotaDay(now))
    expect(quotaDay(reset)).not.toBe(quotaDay(now))
  })
})

describe('quotaExpireAt（日桶过期时间）', () => {
  it('当天 0 点 + 31 天（当天结束 + 30 天）', () => {
    const expire = quotaExpireAt('2026-10-29')
    const start = Date.parse('2026-10-29T00:00:00+08:00')

    expect(expire.getTime() - start).toBe(31 * 24 * 60 * 60 * 1000)
    // 一定晚于下一次重置，不会把「今天还有用的桶」提前删掉
    expect(expire.getTime()).toBeGreaterThan(nextResetAt(new Date('2026-10-29T00:00:00+08:00')).getTime())
  })
})
