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
 *
 * **只记失败请求**（md/53 §12）：2xx / 3xx 不写。成功登录由 `loginrecords`
 * 单独记录，其余成功请求只是流量；只有 >= 400 与中途断开值得回查。
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
  // 落库只留路径，去掉 query（md/45 §10.3）：query 里是关键字、手机号、
  // 甚至是别人贴进链接里的令牌，查日志的人不该顺手看到这些。
  // 长度上限跟模型里的 path.maxlength 一致，超长 query 已被切掉，这里只需防超长路径
  const storedPath = originalUrl.split('?')[0].slice(0, 400)
  let logged = false

  const write = () => {
    if (logged) return
    logged = true

    if (SKIP_PATHS.has(pathname)) return

    // md/53 §12：成功请求不落访问日志。
    //
    // 成功登录已经由 LoginRecord 单独记录，其余 2xx / 3xx 只是流量，
    // 没有排查价值却会迅速把表撑大。只有失败（>= 400）和中途断开才写：
    // 断开时状态码可能还停在默认的 200，用 writableFinished 区分。
    const aborted = !res.writableFinished
    if (res.statusCode < 400 && !aborted) return

    recordAccess({
      method: req.method,
      path: storedPath,
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
