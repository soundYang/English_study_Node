import { Router } from 'express'

import { config } from '../../config/index.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { parseBearer } from './auth.middleware.js'
import { loginUser, logoutUser, registerUser } from './auth.service.js'
import { createCaptcha } from './captcha.service.js'

const router = Router()

/**
 * 三个桶分开（md/33 §6.1）。
 *
 * 验证码是纯计算、不花钱，可以宽松；注册和登录直接决定账号安全，必须紧。
 * 注册按**小时**计：正常人一辈子只注册一次，10 次/时已经宽得离谱。
 */
const captchaLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: config.rateLimitCaptcha,
  message: '请求验证码太频繁，请稍后再试。',
})

const registerLimiter = createIpLimiter({
  windowMs: 60 * 60_000,
  limit: config.rateLimitRegister,
  message: '注册太频繁，请稍后再试。',
})

const loginLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: config.rateLimitLogin,
  message: '登录尝试太频繁，请稍后再试。',
})

/**
 * 退出（md/45 M5）：一次删会话的写操作，成本很低但不该无上限——
 * 用一个宽松的桶（30 次/分钟/IP）挡住「带垃圾令牌空转」的脚本即可。
 */
const logoutLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 30,
  message: '操作太频繁：每分钟最多 30 次，请稍后再试',
})

/** 下发图形验证码。答案只存在于服务端，返回的 SVG 里没有可读文字（md/33 §5） */
router.post('/captcha', captchaLimiter, async (req, res) => {
  res.json(await createCaptcha({ ip: req.ip ?? '' }))
})

router.post('/register', registerLimiter, async (req, res) => {
  const result = await registerUser({
    body: req.body ?? {},
    ip: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
  })

  res.status(201).json(result)
})

router.post('/login', loginLimiter, async (req, res) => {
  const result = await loginUser({
    body: req.body ?? {},
    ip: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
  })

  res.json(result)
})

/**
 * 退出：不要求令牌有效，但挂一个宽松的限流。
 *
 * 幂等的意义在于前端：令牌过期后用户点「退出」，不该收到 401 再弹一次「登录已过期」。
 */
router.post('/logout', logoutLimiter, async (req, res) => {
  res.json(await logoutUser({ token: parseBearer(req.headers.authorization) }))
})

export default router
