import { describe, expect, it } from 'vitest'

import { createGenerationScheduler } from '../modules/readings/generation-scheduler.js'

/** 一个可手动放行的 promise，用来把任务停在 running */
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })

  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const silentLogger = { error() {} }

describe('createGenerationScheduler', () => {
  it('执行槽满后进入队列，队满在 reserve 时 503', async () => {
    const started = []
    const gates = new Map()

    const scheduler = createGenerationScheduler({
      maxActive: 2,
      maxQueue: 1,
      runTask: async (taskId) => {
        started.push(taskId)
        const gate = deferred()
        gates.set(taskId, gate)
        await gate.promise
      },
      logger: silentLogger,
    })

    const first = scheduler.reserve()
    const second = scheduler.reserve()
    const third = scheduler.reserve()

    // capacity = maxActive + maxQueue = 3；第 4 个在扣额度之前就被拒
    let saturated = null
    try {
      scheduler.reserve()
    } catch (error) {
      saturated = error
    }

    expect(saturated).toMatchObject({ status: 503, code: 'GENERATION_SATURATED' })

    scheduler.enqueue('a', first)
    scheduler.enqueue('b', second)
    scheduler.enqueue('c', third)

    await flush()
    expect(started).toEqual(['a', 'b'])
    // pending 包含「已 reserve、还没 start」的排队任务，所以这里还剩 c
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 1, pending: 1 })

    gates.get('a').resolve()
    await flush()

    expect(started).toEqual(['a', 'b', 'c'])
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 0 })

    gates.get('b').resolve()
    gates.get('c').resolve()
    await flush()
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, pending: 0 })
  })

  it('取消排队中的任务会释放槽位，且它之后不会再启动', async () => {
    const started = []
    const gate = deferred()

    const scheduler = createGenerationScheduler({
      maxActive: 1,
      maxQueue: 1,
      runTask: async (taskId) => {
        started.push(taskId)
        await gate.promise
      },
      logger: silentLogger,
    })

    scheduler.enqueue('a', scheduler.reserve())
    scheduler.enqueue('b', scheduler.reserve())
    await flush()

    expect(started).toEqual(['a'])
    expect(scheduler.cancelQueued('b')).toBe(true)
    expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 0 })

    gate.resolve()
    await flush()

    expect(started).toEqual(['a'])
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, pending: 0 })
  })

  it('maxActive=0 是回滚开关：不排队、不限制', async () => {
    const scheduler = createGenerationScheduler({
      maxActive: 0,
      maxQueue: 0,
      runTask: async () => {},
      logger: silentLogger,
    })

    const slots = Array.from({ length: 10 }, () => scheduler.reserve())
    slots.forEach((slot) => slot.release())

    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, pending: 0 })
    await expect(scheduler.runSync(async () => 'ok')).resolves.toBe('ok')
  })

  it('runSync 等不到执行槽时抛 GENERATION_SATURATED', async () => {
    const gate = deferred()
    const scheduler = createGenerationScheduler({
      maxActive: 1,
      maxQueue: 0,
      runTask: async () => {},
      logger: silentLogger,
    })

    const first = scheduler.runSync(async () => {
      await gate.promise
      return 'first'
    })

    await expect(
      scheduler.runSync(async () => 'second', { waitMs: 10 }),
    ).rejects.toMatchObject({ status: 503, code: 'GENERATION_SATURATED' })

    gate.resolve()
    await expect(first).resolves.toBe('first')
    await flush()
    expect(scheduler.snapshot().active).toBe(0)
  })
})
