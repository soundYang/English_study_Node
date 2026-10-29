import { logRequest, logger } from '../logger.js'

/**
 * 请求日志（md/52 之后替换 pino-http，2026-10-29）。
 *
 * 一个请求一行：`19:42:03 GET /api/words?page=1 200 12ms user=local-user`。
 * pino-http 默认打的是整个 req / res 的 JSON，终端里根本看不出前端调了什么。
 *
 * 仍然提供两样 pino-http 带来的东西：
 *   · req.id —— 错误响应里的 requestId，与日志同源（English_vue/md/13 C3）；
 *   · req.log —— errorHandler 兜底记录未处理异常时用。
 */

let sequence = 0

export function requestLogger(req, res, next) {
  req.id = `req-${++sequence}`
  req.log = logger

  const startedAt = process.hrtime.bigint()
  let logged = false

  const write = () => {
    if (logged) return
    logged = true

    // 探活工具高频轮询，日志里全是它没有价值
    if (req.originalUrl === '/api/health') return

    logRequest({
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      userId: req.userId,
    })
  }

  // finish：正常响应写完；close：客户端提前断开。两个都挂，用 logged 去重
  res.on('finish', write)
  res.on('close', write)

  next()
}
