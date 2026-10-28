import { Router } from 'express'

import { config } from '../../config/index.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { changePassword, getProfile, updateProfile } from './profile.service.js'

/**
 * 个人中心路由（md/33 §6.1）。
 *
 * 挂载点已经套了 requireAuth + requireSession（app.js），所以这里能直接信 req.auth。
 */

const router = Router()

/**
 * 改密码单独限流：一次请求要跑一次 scrypt 校验和一次 scrypt 生成，
 * 比任何只读接口都贵，5 次/分足够正常人用，也足够挡住拿旧密码撞库。
 */
const passwordLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: config.rateLimitPassword,
  message: '修改密码太频繁，请稍后再试。',
})

router.get('/', (req, res) => {
  res.json(getProfile({ user: req.auth.user }))
})

router.patch('/', async (req, res) => {
  res.json(await updateProfile({ user: req.auth.user, body: req.body ?? {} }))
})

router.post('/password', passwordLimiter, async (req, res) => {
  res.json(
    await changePassword({
      user: req.auth.user,
      session: req.auth.session,
      body: req.body ?? {},
    }),
  )
})

export default router
