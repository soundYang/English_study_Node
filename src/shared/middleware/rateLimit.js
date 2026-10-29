import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

import { config } from '../../config/index.js'
import { readDeviceId } from '../../modules/quota/quota.service.js'
import { ApiError, ERROR_CODES } from '../errors.js'

/**
 * 生成接口的限流（md/21 W9）。
 *
 * **只挂 `POST /readings/generate`**，不要挂到 `/readings` 前缀上：
 * `/capacity` 每次切换难度都会调，被顺带限流的话用户调几次滑块就再也生成不了。
 * 这条是 md/22 里前端提的硬要求，验收方式是「连续 50 次 /capacity 后生成仍可用」。
 *
 * 计数按 IP：MVP 没有登录，`req.userId` 恒为 DEFAULT_USER_ID，
 * 按它分组等于全站共用一个计数桶，不如直接用 IP。
 *
 * 计的是**请求次数**，不看最终响应码：400 也占配额。这是故意的——
 * 参数写错后脚本反复重跑，一样会把一次 1–5 次付费模型调用的接口打爆。
 */
/**
 * 通用的按 IP 限流器。
 *
 * 与生成限流共用一个实现：响应头格式、错误形状、测试开关都必须一致，
 * 三份拷贝迟早会长出三种行为。
 *
 * @param {{
 *   windowMs: number,
 *   limit: number,
 *   message: string,
 *   enabled?: boolean,
 *   skipSuccessfulRequests?: boolean,
 *   keyGenerator?: (req) => string,
 * }} options
 */
export function createIpLimiter({
  windowMs,
  limit,
  message,
  enabled = config.rateLimitEnabled,
  // 管理员登录用：只数失败次数。成功登录不占配额，
  // 否则同一个人一天登几次就会被自己的正常操作锁住
  skipSuccessfulRequests = false,
  // 默认不传 = express-rate-limit 的按 IP 分组；生成接口用身份桶时再传
  keyGenerator = null,
}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !enabled,
    skipSuccessfulRequests,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req, res, next) => {
      next(
        new ApiError(429, ERROR_CODES.RATE_LIMITED, message, '', {
          limit,
          windowSeconds: Math.round(windowMs / 1000),
        }),
      )
    },
  })
}

/**
 * 全局兜底限流（md/45 M5）。
 *
 * 挂在**所有路由之前**，只回答一个问题：这个 IP 是不是在机器式地狂打？
 * 所以额度必须宽松到「正常用户的峰值 + NAT 后面几台设备」都碰不到：
 * 任务进度是 1 秒一次的轮询，一个人就是 60 次/分钟。
 *
 * 它不能代替具体接口的桶——真正防刷的是那些（生成 20/min、反馈 60/h、
 * 写接口各自一条）；全局桶的价值是给「还没想到要限流的接口」兜一层底。
 */
export function createGlobalLimiter({
  limit = config.rateLimitGlobal,
  enabled = config.rateLimitEnabled,
} = {}) {
  return createIpLimiter({
    windowMs: 60_000,
    limit,
    enabled,
    message: `请求太频繁：同一网络每分钟最多 ${limit} 次，请稍后再试。`,
  })
}

/**
 * 身份桶的键：账号 → 设备 → IP（md/55 §4.9）。
 *
 * 只用 `req.auth.user.dataKey`，不用 `req.userId`：后者在未强制鉴权时
 * 恒为 local-user，会把全站并成一个桶。设备 ID 可伪造，所以它只负责
 * NAT 后的区分度，绕过它的请求由 IP 安全桶兜住。
 */
export function generateRateLimitKey(req) {
  const dataKey = req.auth?.user?.dataKey
  if (dataKey) return `acct:${dataKey}`

  const deviceId = readDeviceId(req.get?.('X-Device-Id'))
  if (deviceId) return `dev:${deviceId}`

  return `ip:${ipKeyGenerator(req.ip ?? '')}`
}

export function createGenerateLimiter({
  windowMs = 60_000,
  limit = config.rateLimitGenerate,
  enabled = config.rateLimitEnabled,
} = {}) {
  // 响应头与错误形状统一由 createIpLimiter 负责：
  // `RateLimit: limit=2, remaining=0, reset=60` + `RateLimit-Policy: 2;w=60`。
  // draft-8 是结构化字段（`"2-in-1min"; r=0; t=60`），curl 一眼看不出剩余几次；
  // 旧版 X-RateLimit-* 不再发，两套都发只会让响应头更难认。
  return createIpLimiter({
    windowMs,
    limit,
    enabled,
    keyGenerator: generateRateLimitKey,
    message: `生成太频繁：每分钟最多 ${limit} 次，请稍后再试。`,
  })
}

/**
 * IP 安全桶（md/55 §4.9）：始终按 IP，挡住轮换设备 ID / 换账号绕过身份桶。
 * 额度比身份桶宽（默认 60/min），正常用户碰不到，只拦脚本。
 */
export function createGenerateIpLimiter({
  windowMs = 60_000,
  limit = config.rateLimitGenerateIp,
  enabled = config.rateLimitEnabled,
} = {}) {
  return createIpLimiter({
    windowMs,
    limit,
    enabled,
    message: `请求太频繁：同一网络每分钟最多 ${limit} 次，请稍后再试。`,
  })
}

/**
 * 路由用的单例。在模块加载时构造，Windows 时长与额度都取自 config，
 * 测试要改的话按 word-expand.test.js 的做法：先在文件顶部设环境变量，再动态 import。
 */
export const generateRateLimit = createGenerateLimiter()
export const generateIpRateLimit = createGenerateIpLimiter()
