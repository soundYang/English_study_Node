import { config } from '../../config/index.js'
import { generationSaturated } from '../../shared/errors.js'
import { logger as defaultLogger } from '../../shared/logger.js'

/**
 * 任务层闸门（md/55 §4.2）。
 *
 * 只负责「同时跑几篇」和「最多排几篇」：
 *   - 任务文档仍在 Mongo，队列只是进程内的 taskId 列表；
 *   - 队列里的任务由 startHeartbeat() 续 queued 心跳，避免被巡检误杀；
 *   - runTask 必须自己把异常转成任务终态，这里只保证槽位一定释放。
 */

const NOOP_SLOT = Object.freeze({ start() {}, release() {} })

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createGenerationScheduler({
  maxActive = config.generationMaxActive,
  maxQueue = config.generationMaxQueue,
  runTask,
  heartbeat = null,
  logger = defaultLogger,
} = {}) {
  if (typeof runTask !== 'function') throw new Error('createGenerationScheduler 需要 runTask')

  // maxActive=0 是回滚开关：不限制任务数，但仍走同一套排队/释放逻辑。
  const effectiveMax = maxActive === 0 ? Infinity : maxActive
  const capacity = effectiveMax + Math.max(0, maxQueue)

  let active = 0
  let pending = 0 // 已 reserve、还没开始执行（含正在队列里等）
  const queue = [] // { taskId, slot }
  let pumping = false
  let timer = null

  function reserve() {
    if (maxActive === 0) return NOOP_SLOT

    if (active + pending >= capacity) {
      throw generationSaturated({
        retryAfter: 5,
        active,
        queued: queue.length,
        maxActive,
        maxQueue,
      })
    }

    pending += 1
    let started = false
    let released = false

    return {
      // 从「排队」变成「执行」：只把 pending 减掉，槽位仍由这个任务持有
      start() {
        if (started) return
        started = true
        pending = Math.max(0, pending - 1)
      },
      release() {
        if (released) return
        released = true
        // 还没开始就被取消 / 创建失败：pending 要还回去
        if (!started) pending = Math.max(0, pending - 1)
      },
    }
  }

  function enqueue(taskId, slot = NOOP_SLOT) {
    queue.push({ taskId, slot })
    pump()
  }

  async function pump() {
    if (pumping) return
    pumping = true

    try {
      while (active < effectiveMax && queue.length > 0) {
        const { taskId, slot } = queue.shift()
        slot.start()
        active += 1

        Promise.resolve()
          .then(() => runTask(taskId))
          .catch((err) => logger.error({ err, taskId }, 'scheduled task failed'))
          .finally(() => {
            active -= 1
            slot.release()
            pump()
          })
      }
    } finally {
      pumping = false
    }
  }

  /** 只移除还没开跑的任务；已开跑的交给 runTask 的 AbortController */
  function cancelQueued(taskId) {
    const index = queue.findIndex((item) => String(item.taskId) === String(taskId))
    if (index < 0) return false

    const [item] = queue.splice(index, 1)
    item.slot.release()
    return true
  }

  /**
   * 同步 /generate 只等「执行槽」，不进任务队列；等不到就 503，
   * 避免几十个 HTTP 连接一起挂着。50ms 轮询是简化实现。
   */
  async function runSync(fn, { waitMs = config.generationSyncWaitMs, signal } = {}) {
    if (maxActive === 0) return fn()

    const startedAt = Date.now()

    for (;;) {
      signal?.throwIfAborted()

      if (active < effectiveMax) {
        active += 1
        try {
          return await fn()
        } finally {
          active -= 1
          pump()
        }
      }

      if (Date.now() - startedAt >= waitMs) {
        throw generationSaturated({
          retryAfter: 5,
          active,
          queued: queue.length,
          maxActive,
          maxQueue,
        })
      }

      await wait(50, signal)
    }
  }

  function startHeartbeat() {
    if (timer) return

    timer = setInterval(() => {
      Promise.resolve(heartbeat?.()).catch(() => {})
    }, config.taskHeartbeatMs)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    reserve,
    enqueue,
    cancelQueued,
    runSync,
    pump,
    startHeartbeat,
    stop,
    snapshot: () => ({ active, queued: queue.length, pending, maxActive, maxQueue }),
  }
}
