import { Router } from 'express'

import { config } from '../../config/index.js'
import { logger } from '../../shared/logger.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { parseBearer } from '../auth/auth.middleware.js'
import {
  getFeedbackDetail,
  listFeedback,
  updateFeedback,
} from '../feedback/feedback.service.js'
import { requireAdmin } from './admin.middleware.js'
import {
  adminFeedbackPatchSchema,
  adminFeedbackQuerySchema,
  adminLoginSchema,
  adminUsersQuerySchema,
} from './admin.schema.js'
import {
  getOverview,
  getUserDetail,
  listUsers,
  loginAdmin,
  logoutAdmin,
  toAdminDto,
} from './admin.service.js'

const router = Router()

/**
 * 登录限流：5 次失败 / 15 分钟 / IP（md/37 §2.5）。
 *
 * `skipSuccessfulRequests` 是关键：成功登录不占配额，
 * 否则管理员自己一天登几次、再多看几眼页面，就会被自己的正常操作锁在外面。
 * 失败一律计数——爆破者每次都要付一次代价。
 */
const adminLoginLimiter = createIpLimiter({
  windowMs: 15 * 60_000,
  limit: 5,
  message: '登录失败次数过多，请 15 分钟后再试。',
  skipSuccessfulRequests: true,
})

router.post('/auth/login', adminLoginLimiter, async (req, res) => {
  const body = parseOrThrow(adminLoginSchema, req.body ?? {})

  res.json(
    await loginAdmin({
      ...body,
      ip: req.ip ?? '',
      userAgent: req.get('user-agent') ?? '',
    }),
  )
})

/** 登出不要求令牌有效：与用户侧同一原则，幂等，不弹 401 */
router.post('/auth/logout', async (req, res) => {
  res.json(await logoutAdmin(parseBearer(req.headers.authorization)))
})

router.get('/auth/me', requireAdmin, (req, res) => {
  res.json(toAdminDto(req.admin))
})

// ——— 以下全部需要管理员令牌 ———
router.use(requireAdmin)

router.get('/overview', async (req, res) => {
  res.json(await getOverview())
})

router.get('/users', async (req, res) => {
  const query = parseOrThrow(adminUsersQuerySchema, req.query)

  res.json(await listUsers(query))
})

router.get('/users/:dataKey', async (req, res) => {
  const { dataKey } = req.params

  // 详情页给全量手机号，属于隐私访问：必须留痕（§6）
  logger.info(
    { admin: req.admin.username, action: 'user.detail', target: dataKey, ip: req.ip ?? '' },
    'admin action',
  )

  res.json(await getUserDetail({ dataKey }))
})

router.get('/feedback', async (req, res) => {
  const query = parseOrThrow(adminFeedbackQuerySchema, req.query)

  res.json(await listFeedback(query))
})

router.get('/feedback/:id', async (req, res) => {
  res.json(await getFeedbackDetail(req.params.id))
})

router.patch('/feedback/:id', async (req, res) => {
  const body = parseOrThrow(adminFeedbackPatchSchema, req.body ?? {})

  res.json(
    await updateFeedback({
      id: req.params.id,
      status: body.status,
      reply: body.reply,
      admin: req.admin.username || config.adminUsername,
    }),
  )
})

export default router
