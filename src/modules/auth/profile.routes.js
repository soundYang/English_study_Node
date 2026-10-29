import { Router } from 'express'

import { config } from '../../config/index.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import {
  getApiKeyView,
  removeApiKey,
  saveApiKey,
  verifyStoredApiKey,
} from '../ai-keys/ai-key.service.js'
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

/**
 * 自备 Key 的写操作共用一个桶（md/43 §5）：PUT / DELETE / verify 都算一次。
 * 一次 verify 会向上游发请求，不挂限流等于给了一个免费探活 / 撞 Key 的入口。
 * GET 不挂：只读自己的文档，与 /stats 同理。
 */
const apiKeyLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: config.rateLimitApiKey,
  message: '操作太频繁，请稍后再试。',
})

/**
 * 改资料（md/45 M5）：一次写。正常人是「改完点保存」，
 * 30 次/分钟已经够反复试昵称 / 签名的长度边界。
 */
const profileWriteLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 30,
  message: '操作太频繁：每分钟最多 30 次，请稍后再试',
})

router.get('/', (req, res) => {
  res.json(getProfile({ user: req.auth.user }))
})

router.patch('/', profileWriteLimiter, async (req, res) => {
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

/**
 * 用户自备 API Key（md/43）。
 *
 * 功能关闭时 GET 仍返回 200 + `enabled: false`（前端整块隐藏），
 * 写操作返回 503 USER_API_KEY_DISABLED。
 */
router.get('/api-key', async (req, res) => {
  res.json(await getApiKeyView({ userId: req.auth.user.dataKey }))
})

router.put('/api-key', apiKeyLimiter, async (req, res) => {
  res.json(await saveApiKey({ userId: req.auth.user.dataKey, body: req.body ?? {} }))
})

router.delete('/api-key', apiKeyLimiter, async (req, res) => {
  res.json(await removeApiKey({ userId: req.auth.user.dataKey }))
})

router.post('/api-key/verify', apiKeyLimiter, async (req, res) => {
  res.json(await verifyStoredApiKey({ userId: req.auth.user.dataKey }))
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
