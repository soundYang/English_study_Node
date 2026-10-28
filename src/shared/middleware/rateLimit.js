import rateLimit from 'express-rate-limit'

import { config } from '../../config/index.js'
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
export function createGenerateLimiter({
  windowMs = 60_000,
  limit = config.rateLimitGenerate,
  enabled = config.rateLimitEnabled,
} = {}) {
  return rateLimit({
    windowMs,
    limit,
    // `RateLimit: limit=2, remaining=0, reset=60` + `RateLimit-Policy: 2;w=60`。
    // draft-8 是结构化字段（`"2-in-1min"; r=0; t=60`），curl 一眼看不出剩余几次；
    // 旧版 X-RateLimit-* 不再发，两套都发只会让响应头更难认。
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // 测试环境整体关闭：否则一次打满配额的用例会让同文件后面的用例全部 429
    skip: () => !enabled,
    // 走统一错误出口，响应体与其它业务错误同形：
    // { error: { code, message, details }, requestId }
    handler: (req, res, next) => {
      next(
        new ApiError(
          429,
          ERROR_CODES.RATE_LIMITED,
          `生成太频繁：每分钟最多 ${limit} 次，请稍后再试。`,
          '',
          { limit, windowSeconds: Math.round(windowMs / 1000) },
        ),
      )
    },
  })
}

/**
 * 路由用的单例。在模块加载时构造，Windows 时长与额度都取自 config，
 * 测试要改的话按 word-expand.test.js 的做法：先在文件顶部设环境变量，再动态 import。
 */
export const generateRateLimit = createGenerateLimiter()
