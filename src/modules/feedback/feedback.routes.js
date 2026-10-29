import { Router } from 'express'

import { readDeviceId } from '../quota/quota.service.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { createFeedbackSchema } from './feedback.schema.js'
import { createFeedback } from './feedback.service.js'

const router = Router()

/**
 * POST /api/feedback（md/37 §5.1）。
 *
 * **不挂 requireAuth**：未登录也能反馈，这对客服有价值。
 * 能拿到身份就存快照，拿不到就落 `anonymous`——不要因此 401，
 * 那会把「在登录页卡住了」这个最常见的反馈场景挡在门外。
 *
 * 限流在 service 里按「设备 / 天」数库，不走 express-rate-limit：
 * 反馈要的是「一天最多 5 条」，重启进程不该把计数清零。
 */
router.post('/', async (req, res) => {
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
