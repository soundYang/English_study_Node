import { describe, expect, it } from 'vitest'

import { createNoopSemaphore, createSemaphore } from '../shared/concurrency/semaphore.js'

/**
 * 上游信号量（md/55 §4.1）。
 *
 * 只测并发计数与等待队列的边界：超限排队、释放转交、abort / 超时清理。
 * 业务错误映射（AI_PROVIDER_BUSY）由 ai.client 负责，不在这里断言。
 */
describe('createSemaphore', () => {
  it('超过上限的 acquire 会排队，释放后按 FIFO 转交', async () => {
    const semaphore = createSemaphore({ limit: 1 })
    const first = await semaphore.acquire()

    expect(semaphore.snapshot()).toMatchObject({ active: 1, waiting: 0 })

    let secondAcquired = false
    const secondPromise = semaphore.acquire().then((release) => {
      secondAcquired = true
      return release
    })

    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    expect(semaphore.snapshot()).toMatchObject({ active: 1, waiting: 1 })

    first()
    const second = await secondPromise

    expect(secondAcquired).toBe(true)
    // 槽位是转交，不是「先减再加」：active 仍是 1
    expect(semaphore.snapshot()).toMatchObject({ active: 1, waiting: 0 })

    second()
    expect(semaphore.snapshot()).toMatchObject({ active: 0, waiting: 0 })
  })

  it('release 幂等：重复调用不会多放一个请求进来', async () => {
    const semaphore = createSemaphore({ limit: 1 })
    const first = await semaphore.acquire()

    first()
    first()

    expect(semaphore.snapshot().active).toBe(0)

    const second = await semaphore.acquire()
    expect(semaphore.snapshot().active).toBe(1)
    second()
  })

  it('等待中的 acquire 被 abort 后从队列移除', async () => {
    const semaphore = createSemaphore({ limit: 1 })
    const release = await semaphore.acquire()
    const controller = new AbortController()

    const waiting = semaphore.acquire({ signal: controller.signal })
    expect(semaphore.snapshot().waiting).toBe(1)

    controller.abort()

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(semaphore.snapshot().waiting).toBe(0)
    release()
    expect(semaphore.snapshot().active).toBe(0)
  })

  it('等待超时抛 SemaphoreTimeoutError，不泄漏 waiter', async () => {
    const semaphore = createSemaphore({ limit: 1 })
    const release = await semaphore.acquire()

    await expect(semaphore.acquire({ timeoutMs: 5 })).rejects.toMatchObject({
      name: 'SemaphoreTimeoutError',
    })
    expect(semaphore.snapshot().waiting).toBe(0)

    release()
  })

  it('no-op 信号量不计数，供 UPSTREAM_MAX_CONCURRENCY=0 回滚', async () => {
    const semaphore = createNoopSemaphore()
    const a = await semaphore.acquire()
    const b = await semaphore.acquire()

    expect(semaphore.snapshot()).toMatchObject({ active: 0, waiting: 0, limit: 0 })
    a()
    b()
  })
})
