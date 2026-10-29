import OpenAI from 'openai'

import { config } from '../../config/index.js'
import {
  ApiError,
  ERROR_CODES,
  aiProviderBusy,
  userApiKeyExpired,
} from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { createNoopSemaphore, createSemaphore } from '../../shared/concurrency/semaphore.js'

let freeClient = null

/** 上游报错只留诊断信息，且把可能出现的 key 片段抹掉 */
function describeUpstreamError(err) {
  const message = String(err?.error?.message ?? err?.message ?? '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 300)

  return {
    name: err?.name,
    status: err?.status,
    code: err?.code ?? err?.error?.code,
    type: err?.error?.type,
    message,
  }
}

/**
 * 可重试的上游失败（md/55 §4.5.1）：
 * 连接层错误、408/429/5xx。400/404/422 是我们请求写错了，重试没用。
 */
function isRetryable(err) {
  if (err?.name === 'APIConnectionTimeoutError' || err?.name === 'APIConnectionError') return true
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET') return true
  if ([408, 429, 500, 502, 503, 504].includes(Number(err?.status))) return true

  return /timed out|timeout|socket hang up|connection reset/i.test(String(err?.message ?? ''))
}

/** 上游 429 可能带 Retry-After：秒数或 HTTP 日期，统一转毫秒 */
function retryAfterMs(err) {
  let raw = err?.headers?.['retry-after']
    ?? err?.response?.headers?.get?.('retry-after')
    ?? err?.error?.headers?.['retry-after']

  if (Array.isArray(raw)) raw = raw[0]
  if (raw === undefined || raw === null || raw === '') return 0

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const timestamp = Date.parse(String(raw))
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0
}

function abortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** 可被 signal 中断的 sleep：取消后不能还占着一次重试的等待 */
function sleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 免费 Key 的熔断器（md/55 §4.5.3）。
 *
 * 状态机：closed → open（窗口内连续失败达到阈值）→ halfOpen（openMs 后）
 * → 成功 closed / 失败重新 open。只由免费 Key 使用；自备 Key 的失败是
 * 用户自己的凭据问题，不能把全站熔断。
 *
 * `now` 可注入，测试不必真的等 30 秒。
 */
export function createCircuitBreaker({
  failureThreshold = config.aiCircuitFailures,
  windowMs = config.aiCircuitWindowMs,
  openMs = config.aiCircuitOpenMs,
  now = () => Date.now(),
} = {}) {
  let state = 'closed'
  let failures = 0
  // null 而不是 0：注入的 now 可以从 0 开始，0 是合法时间戳，不能兼作哨兵
  let windowStart = null
  let openedAt = 0
  let probeInFlight = false

  function open() {
    const wasOpen = state === 'open'
    state = 'open'
    openedAt = now()
    probeInFlight = false

    if (!wasOpen) {
      logger.warn({ failures, failureThreshold }, 'ai circuit opened')
    }
  }

  /** 返回 false = 这次请求直接拒绝，不打上游 */
  function allow() {
    if (state === 'closed') return true

    if (state === 'open') {
      if (now() - openedAt < openMs) return false
      state = 'halfOpen'
      probeInFlight = false
    }

    if (state === 'halfOpen') {
      if (probeInFlight) return false
      probeInFlight = true
      return true
    }

    return false
  }

  function success() {
    if (state !== 'closed') logger.info('ai circuit closed')

    state = 'closed'
    failures = 0
    windowStart = null
    probeInFlight = false
  }

  function failure() {
    if (state === 'halfOpen') {
      open()
      return
    }

    if (state === 'open') return

    const current = now()

    // 窗口过期后重新计数；否则统计的是「历史总失败」，永远关不上
    if (windowStart === null || current - windowStart > windowMs) {
      windowStart = current
      failures = 1
    } else {
      failures += 1
    }

    if (failures >= failureThreshold) open()
  }

  /** 半开探针没有真正到达上游（取消 / 信号量超时）时释放占位，不判失败 */
  function releaseProbe() {
    if (state === 'halfOpen') probeInFlight = false
  }

  return {
    allow,
    success,
    failure,
    releaseProbe,
    snapshot: () => ({ state, failures, openedAt, probeInFlight }),
  }
}

/** 免费 Key 懒初始化：没有 key 的测试环境不会在这里就抛错 */
function getFreeClient() {
  if (!freeClient) freeClient = createClient(config.deepseekApiKey || 'missing-api-key')

  return freeClient
}

/**
 * 自备 Key **不缓存**（md/43 §6.4）。
 *
 * 构造 OpenAI 客户端是纯内存操作，一篇长文 20–40 次调用完全可忽略；
 * 换来的是用户 Key 不会长期留在进程内存里，删除 / 替换后下一次生成就换新 Key。
 */
function createClient(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: config.deepseekBaseUrl,
    timeout: config.deepseekTimeoutMs,
    // 重试由我们自己的修正轮控制，叠加 SDK 重试会把调用次数放大到不可控
    maxRetries: 0,
  })
}

const freeCircuit = createCircuitBreaker()
const upstreamSemaphore = config.upstreamMaxConcurrency > 0
  ? createSemaphore({ limit: config.upstreamMaxConcurrency, name: 'deepseek' })
  : createNoopSemaphore({ name: 'deepseek' })

/** health 只读快照；不暴露 Key、用户或任务 id */
export function getAiRuntimeSnapshot() {
  const snapshot = upstreamSemaphore.snapshot()

  return {
    upstreamActive: snapshot.active,
    upstreamWaiting: snapshot.waiting,
    circuit: freeCircuit.snapshot().state,
  }
}

/**
 * 调一次上游，返回原始文本与用量。
 *
 * 错误映射：
 *   - 可重试失败按指数退避 + full jitter 重试，最多 1 + AI_MAX_RETRIES 次；
 *   - 熔断打开 / 信号量排队超时 → 503 AI_PROVIDER_BUSY；
 *   - 其它最终失败 → 502 AI_PROVIDER_ERROR；
 *   - 自备 Key 401/403 → USER_API_KEY_INVALID（不重试、不熔断）。
 *
 * **绝不把上游原始报错透给前端**（可能含 key 片段或内部信息）。
 */
export async function chatJson({
  messages,
  signal,
  maxTokens,
  temperature = 0.8,
  // 自备 Key 由调用方一次性解析后传进来（md/43）；默认仍是服务端免费 Key
  apiKey = config.deepseekApiKey,
  keySource = 'free',
}) {
  const client = keySource === 'user' ? createClient(apiKey) : getFreeClient()
  const maxAttempts = 1 + Math.max(0, config.aiMaxRetries)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // 熔断只对免费 Key 生效；自备 Key 永远不因为别人的失败被拒绝
    if (keySource === 'free' && !freeCircuit.allow()) {
      throw aiProviderBusy({ retryAfter: 10 })
    }

    let release
    try {
      release = await upstreamSemaphore.acquire({
        signal,
        timeoutMs: config.upstreamWaitTimeoutMs,
      })
    } catch (error) {
      if (keySource === 'free') freeCircuit.releaseProbe()

      if (signal?.aborted || error?.name === 'AbortError') throw error
      if (error?.name === 'SemaphoreTimeoutError') throw aiProviderBusy({ retryAfter: 10 })

      throw error
    }

    try {
      const response = await client.chat.completions.create(
        {
          model: config.deepseekModel,
          messages,
          // DeepSeek 的 JSON 模式要求提示词里出现 "json" 字样，系统提示词已满足
          response_format: { type: 'json_object' },
          // 整篇路径沿用 0.8；分段路径由调用方显式传 0.5（md/21 W4）
          temperature,
          max_tokens: maxTokens,
        },
        { signal },
      )

      if (keySource === 'free') freeCircuit.success()

      const choice = response.choices[0]

      // 截断时 finish_reason = 'length'，正文末尾会缺一大截，调用方要能看见
      return {
        content: choice?.message?.content ?? '',
        usage: response.usage ?? null,
        finishReason: choice?.finish_reason ?? null,
      }
    } catch (err) {
      // 客户端主动取消 / 整篇 deadline：不映射成 502，原样抛出，
      // 由路由或 runTask 区分「用户取消」与「超时」
      if (signal?.aborted || err?.name === 'AbortError') {
        if (keySource === 'free') freeCircuit.releaseProbe()
        throw err
      }

      logger.warn(
        { err: describeUpstreamError(err), attempt, maxAttempts, keySource },
        'deepseek request failed',
      )

      // 自备 Key 被上游拒绝：这是用户的凭据问题，不是我们的服务故障。
      // 免费 Key 的 401 仍按 502 处理——不要把「服务端 Key 坏了」透给用户
      if (keySource === 'user' && (err?.status === 401 || err?.status === 403)) {
        throw userApiKeyExpired()
      }

      const retryable = isRetryable(err)

      // 上游正常回了 4xx：探针已经到达上游，释放半开占位（不把请求本身的错算成故障）
      if (keySource === 'free' && !retryable) freeCircuit.success()
      if (keySource === 'free' && retryable) freeCircuit.failure()

      if (retryable && attempt < maxAttempts) {
        // 指数退避 + full jitter；Retry-After 与本地退避取较大值
        const exponential = Math.min(
          config.aiRetryMaxMs,
          config.aiRetryBaseMs * 2 ** (attempt - 1),
        )
        const delay = Math.max(Math.random() * exponential, retryAfterMs(err))

        if (delay > 0) await sleep(delay, signal)
        continue
      }

      throw new ApiError(
        502,
        ERROR_CODES.AI_PROVIDER_ERROR,
        'AI 服务暂时不可用，请稍后重试。',
      )
    } finally {
      release?.()
    }
  }
}
