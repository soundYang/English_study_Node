/**
 * 带 FIFO 等待队列、可被 AbortSignal 中断的信号量（md/55 §4.1）。
 *
 * 只做并发计数，不认识业务错误码：
 *   - abort  → name = 'AbortError'
 *   - 超时   → name = 'SemaphoreTimeoutError'
 * 由调用方（ai.client.js）翻译成 AI_PROVIDER_BUSY 或原样透传取消。
 */

function namedError(name, message) {
  const error = new Error(message)
  error.name = name
  return error
}

export const abortError = () => namedError('AbortError', 'aborted')
export const semaphoreTimeoutError = () =>
  namedError('SemaphoreTimeoutError', 'semaphore wait timeout')

export function createSemaphore({ limit, name = 'semaphore' } = {}) {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('createSemaphore 需要大于 0 的 limit')
  }

  let active = 0
  const waiters = [] // { resolve, reject, signal, timer, onAbort, cleanup }

  /**
   * 每次 acquire 返回的 release 只生效一次。
   * 槽位直接转交给下一个 waiter 时，也给对方一个新的 release——
   * 不能让两个调用方共享同一个释放函数。
   */
  function makeRelease() {
    let released = false

    return function release() {
      if (released) return
      released = true

      const next = waiters.shift()

      if (next) {
        next.cleanup()
        next.resolve(makeRelease())
        return
      }

      active = Math.max(0, active - 1)
    }
  }

  async function acquire({ signal, timeoutMs = 0 } = {}) {
    if (signal?.aborted) throw abortError()

    if (active < limit) {
      active += 1
      return makeRelease()
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, timer: null, onAbort: null, cleanup: null }

      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer)
        signal?.removeEventListener('abort', waiter.onAbort)
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
      }

      waiter.cleanup = cleanup
      waiter.onAbort = () => {
        cleanup()
        reject(abortError())
      }

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          cleanup()
          reject(semaphoreTimeoutError())
        }, timeoutMs)
      }

      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  return {
    acquire,
    snapshot: () => ({ name, active, waiting: waiters.length, limit }),
  }
}

/** `UPSTREAM_MAX_CONCURRENCY=0` 的回滚开关：不排队、不计数 */
export function createNoopSemaphore({ name = 'noop' } = {}) {
  return {
    acquire: async () => () => {},
    snapshot: () => ({ name, active: 0, waiting: 0, limit: 0 }),
  }
}
