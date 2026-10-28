import { Router } from 'express'

import { config } from '../../config/index.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { changePassword, getProfile, updateProfile } from './profile.service.js'
import { getProfileStats } from './profile.stats.js'

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

/**
 * 统计不挂限流：一次 Mongo 聚合，不花钱、不调模型。
 * md/21 W9 的教训是只读接口被顺带塞进生成桶，这里不再犯。
 */
router.get('/stats', async (req, res) => {
  // 统计的是业务数据，归属看 dataKey（不是 users._id）
  res.json(await getProfileStats({ userId: req.auth.user.dataKey }))
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
