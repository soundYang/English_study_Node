import { describe, expect, it } from 'vitest'

import { createCircuitBreaker } from '../modules/readings/ai.client.js'

/**
 * 免费 Key 熔断器（md/55 §4.5.3）。
 *
 * 用可注入的 now 推进时间，不真的 sleep；重点钉住三态转换与半开只放一个探针。
 */
describe('createCircuitBreaker', () => {
  it('窗口内失败达到阈值就打开，openMs 后只放一个半开探针', () => {
    let now = 0
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      windowMs: 1000,
      openMs: 500,
      now: () => now,
    })

    expect(breaker.snapshot().state).toBe('closed')
    expect(breaker.allow()).toBe(true)

    breaker.failure()
    breaker.failure()

    expect(breaker.snapshot().state).toBe('open')
    expect(breaker.allow()).toBe(false)

    now = 499
    expect(breaker.allow()).toBe(false)

    now = 500
    // 第一个请求进入半开并占住探针位
    expect(breaker.allow()).toBe(true)
    // 并发的第二个请求不能再打上游
    expect(breaker.allow()).toBe(false)

    breaker.failure()
    expect(breaker.snapshot().state).toBe('open')
  })

  it('半开探针成功 → 关闭并清零失败计数', () => {
    let now = 0
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      windowMs: 1000,
      openMs: 100,
      now: () => now,
    })

    breaker.failure()
    expect(breaker.snapshot().state).toBe('open')

    now = 100
    expect(breaker.allow()).toBe(true)
    breaker.success()

    expect(breaker.snapshot()).toMatchObject({ state: 'closed', failures: 0 })
    expect(breaker.allow()).toBe(true)
  })

  it('半开探针未真正打到上游（取消 / 信号量超时）时释放占位', () => {
    let now = 0
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      windowMs: 1000,
      openMs: 100,
      now: () => now,
    })

    breaker.failure()
    now = 100
    expect(breaker.allow()).toBe(true)
    expect(breaker.allow()).toBe(false)

    breaker.releaseProbe()
    expect(breaker.allow()).toBe(true)
  })

  it('窗口过期后重新计数，不会被很久以前的失败一直锁死', () => {
    let now = 0
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      windowMs: 1000,
      openMs: 500,
      now: () => now,
    })

    breaker.failure()
    breaker.failure()
    expect(breaker.snapshot().state).toBe('closed')

    now = 2000
    breaker.failure()
    // 新窗口从这次重新计数，旧的两笔失败已经过期
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', failures: 1 })
  })
})
