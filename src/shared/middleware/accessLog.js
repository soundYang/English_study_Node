import { config } from '../../config/index.js'
import { recordAccess } from '../../modules/logs/log.service.js'

/**
 * 访问日志落库（md/53）。
 *
 * 与 requestLogger 的分工：
 *   · requestLogger —— 打终端，重启就没了；
 *   · accessLogger  —— 写 Mongo，能按 IP / 用户 / 路径回查。
 *
 * 写库在响应结束之后异步进行，不阻塞返回；失败只打终端 warn。
 * 请求体和请求头都不落库：自备 Key 接口的 body 是明文密钥，令牌在 Authorization 里。
 */

/** 探活轮询高频且无信息量 */
const SKIP_PATHS = new Set(['/api/health'])

export function accessLogger(req, res, next) {
  if (!config.accessLogEnabled) return next()

  const startedAt = process.hrtime.bigint()
  // 路径在**进入中间件时**就取好：响应结束时 Express 已经把 req.url 还原/改写过，
  // 这时再读 req.path 拿到的不是用户请求的那条路径（跳过的判断会失效）
  const pathname = req.path
  const originalUrl = req.originalUrl
  let logged = false

  const write = () => {
    if (logged) return
    logged = true

    if (SKIP_PATHS.has(pathname)) return

    recordAccess({
      method: req.method,
      path: originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
      ip: req.ip ?? '',
      userId: req.userId ?? '',
      userAgent: req.get('user-agent') ?? '',
      origin: req.get('origin') ?? '',
      requestId: req.id ?? '',
    })
  }

  // finish：正常响应写完；close：客户端提前断开。两个都挂，用 logged 去重
  res.on('finish', write)
  res.on('close', write)

  next()
}
