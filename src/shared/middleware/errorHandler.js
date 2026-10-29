import { recordError } from '../../modules/logs/log.service.js'
import { ApiError, ERROR_CODES } from '../errors.js'

/**
 * 落库用的错误码。`err.code` 优先（mongoose 的 11000 这类最有信息量），
 * 没有再用 `err.name`；但普通 `new Error()` 的 name 恒为 'Error'，
 * 按它分组等于没分组，统一归到 INTERNAL_ERROR。
 */
function errorCodeOf(err) {
  if (typeof err?.code === 'string' || typeof err?.code === 'number') {
    return String(err.code)
  }

  const name = typeof err?.name === 'string' ? err.name : ''
  return name && name !== 'Error' ? name : ERROR_CODES.INTERNAL_ERROR
}

/**
 * 把没被业务接住的异常落库（md/53）。只记 5xx：4xx 是预期内的分支，
 * 答案在访问日志的 statusCode 里，混进来只会把真正的异常淹掉。
 */
function persistServerError(req, { statusCode = 500, code, message, stack }) {
  recordError({
    requestId: String(req.id ?? ''),
    method: String(req.method ?? ''),
    path: String(req.originalUrl ?? '').slice(0, 400),
    statusCode,
    code: String(code ?? '').slice(0, 100),
    message: String(message ?? '').slice(0, 1000),
    stack: String(stack ?? '').slice(0, 8000),
    ip: String(req.ip ?? ''),
    userId: String(req.userId ?? ''),
    userAgent: String(req.get?.('user-agent') ?? '').slice(0, 300),
  })
}

/**
 * 统一错误出口。必须是 4 个参数，且注册在所有路由之后——
 * Express 靠参数个数识别错误处理中间件，少一个就会被当成普通中间件。
 */
export function errorHandler(err, req, res, _next) {
  // 响应已经开始写了，交回 Express 默认处理，否则会报 headers already sent
  if (res.headersSent) return _next(err)

  // 已经归一化的业务异常 → 按原样返回
  if (err instanceof ApiError) {
    // 5xx 的 ApiError 仍然是「意外」，需要留痕；4xx 是预期分支，不写
    if (err.status >= 500) {
      persistServerError(req, {
        statusCode: err.status,
        code: err.code,
        message: err.message,
        stack: err.stack,
      })
    }

    // 每日额度是「等明天」，必须给标准 Retry-After（md/35 §7.2）。
    // 秒数按 resetAt 现算而不是缓存在 details 里：从扣额度到响应发出可能隔了几秒
    if (err.code === ERROR_CODES.QUOTA_EXCEEDED && err.details?.resetAt) {
      const seconds = Math.max(1, Math.ceil((Date.parse(err.details.resetAt) - Date.now()) / 1000))

      // 这个请求也穿过了生成限流器，它会留下分钟级的 RateLimit 头。
      // 前端 `retryAfterOf` 优先读它，会和「等明天」的 Retry-After 打架，必须摘掉
      res.removeHeader('RateLimit')
      res.removeHeader('RateLimit-Policy')
      res.set('Retry-After', String(seconds))
    }

    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.field && { field: err.field }),
        // details 只在业务显式给了才出现：没给的错误，响应体与之前逐字节一致
        ...(err.details && { details: err.details }),
      },
      // 与 pino-http 的 req.id 同源：用户报错时凭这个号去日志里定位（English_vue/md/13 C3）
      requestId: req.id,
    })
  }

  // 请求体不是合法 JSON（express.json 抛的）
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: ERROR_CODES.INVALID_REQUEST, message: '请求体不是合法 JSON' },
    })
  }

  // 请求体超过 64kb。这是客户端的问题，不能掉进 500
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: ERROR_CODES.INVALID_REQUEST, message: '请求体过大' },
    })
  }

  // 其余一律 500：日志留全栈，响应只给固定文案。
  // 红线：绝不能把 err.message 或堆栈返回给前端。
  req.log?.error({ err }, 'unhandled error')
  persistServerError(req, {
    code: errorCodeOf(err),
    message: err?.message,
    stack: err?.stack,
  })
  res.status(500).json({
    error: { code: ERROR_CODES.INTERNAL_ERROR, message: '服务器内部错误' },
    // 500 最需要这个号：用户只能提供「什么时候点的」，有 id 才能对上日志
    requestId: req.id,
  })
}
