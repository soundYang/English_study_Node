import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 闸门类 5xx 的可观测性（md/55 §7.1）。
 *
 * 它们会进访问日志，但不能进 ErrorLog：一次流量高峰里几千条
 * GENERATION_SATURATED 会把真正的异常淹掉。
 */
process.env.ERROR_LOG_ENABLED = 'true'

const {
  ApiError,
  ERROR_CODES,
  aiProviderBusy,
  generationTimeout,
} = await import('../shared/errors.js')
const { ErrorLog } = await import('../modules/logs/error-log.model.js')
const { errorHandler } = await import('../shared/middleware/errorHandler.js')

function appWith(errorFactory) {
  const mini = express()
  mini.get('/x', (req, res, next) => next(errorFactory()))
  mini.use(errorHandler)
  return mini
}

async function waitFor(check, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  return false
}

describe('闸门类 5xx', () => {
  it('AI_PROVIDER_BUSY 带 Retry-After，且不写 ErrorLog', async () => {
    const app = appWith(() => aiProviderBusy({ retryAfter: 7 }))

    const res = await request(app).get('/x')

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('AI_PROVIDER_BUSY')
    expect(res.headers['retry-after']).toBe('7')

    // 给 fire-and-forget 的日志写入留出时间，确认它确实没有写
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await ErrorLog.countDocuments({})).toBe(0)
  })

  it('GENERATION_TIMEOUT / GENERATION_SATURATED 同样不写 ErrorLog', async () => {
    const timeout = appWith(() => generationTimeout({ deadlineMs: 120000 }))
    const saturated = appWith(() => new ApiError(
      503,
      ERROR_CODES.GENERATION_SATURATED,
      'busy',
      '',
      { retryAfter: 5 },
    ))

    expect((await request(timeout).get('/x')).status).toBe(504)
    expect((await request(saturated).get('/x')).status).toBe(503)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await ErrorLog.countDocuments({})).toBe(0)
  })

  it('真正的上游 502 仍然写 ErrorLog', async () => {
    const app = appWith(() => new ApiError(
      502,
      ERROR_CODES.AI_PROVIDER_ERROR,
      'upstream down',
    ))

    const res = await request(app).get('/x')
    expect(res.status).toBe(502)

    expect(await waitFor(async () => (await ErrorLog.countDocuments({})) === 1)).toBe(true)
  })
})
