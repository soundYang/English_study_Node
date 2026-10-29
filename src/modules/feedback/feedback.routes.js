import { Router } from 'express'

import { config } from '../../config/index.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { readDeviceId } from '../quota/quota.service.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { createFeedbackSchema } from './feedback.schema.js'
import { createFeedback } from './feedback.service.js'

const router = Router()

/**
 * 按 IP 的请求闸（md/45 M3）。
 *
 * 与 service 里的「设备 5 / IP 20 次每天」是两道不同的闸：
 *   · 这一道数**请求次数**，参数写错、校验不通过也占额度，挡的是脚本空转；
 *   · 数库那道只数**成功写入**的条数，重启进程不会清零。
 * 默认 60 次/小时/IP——比每日 20 条宽，正常用户碰不到。
 */
const feedbackLimiter = createIpLimiter({
  windowMs: 60 * 60_000,
  limit: config.rateLimitFeedback,
  message: '反馈提交太频繁，请稍后再试。',
})

/**
 * POST /api/feedback（md/37 §5.1）。
 *
 * **不挂 requireAuth**：未登录也能反馈，这对客服有价值。
 * 能拿到身份就存快照，拿不到就落 `anonymous`——不要因此 401，
 * 那会把「在登录页卡住了」这个最常见的反馈场景挡在门外。
 *
 * 两道限流：路由层这个 IP 桶只挡请求洪峰（1 小时窗口，进程内计数）；
 * 「一天最多几条」在 service 里按**设备 5 / IP 20** 数库，重启不会清零。
 */
router.post('/', feedbackLimiter, async (req, res) => {
  const body = parseOrThrow(createFeedbackSchema, req.body ?? {})

  const result = await createFeedback({
    userId: req.userId,
    body,
    deviceId: readDeviceId(req.get('X-Device-Id')),
    ip: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
  })

  res.status(201).json(result)
})

export default router
