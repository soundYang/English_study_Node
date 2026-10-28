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
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.field && { field: err.field }),
        // details 只在业务显式给了才出现：没给的错误，响应体与之前逐字节一致
        ...(err.details && { details: err.details }),
      },
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
  })
}
