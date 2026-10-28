import { ApiError, ERROR_CODES } from '../errors.js'

/**
 * 统一错误出口。必须是 4 个参数，且注册在所有路由之后——
 * Express 靠参数个数识别错误处理中间件，少一个就会被当成普通中间件。
 */
export function errorHandler(err, req, res, _next) {
  // 响应已经开始写了，交回 Express 默认处理，否则会报 headers already sent
  if (res.headersSent) return _next(err)

  // 已经归一化的业务异常 → 按原样返回
  if (err instanceof ApiError) {
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
  res.status(500).json({
    error: { code: ERROR_CODES.INTERNAL_ERROR, message: '服务器内部错误' },
    // 500 最需要这个号：用户只能提供「什么时候点的」，有 id 才能对上日志
    requestId: req.id,
  })
}
