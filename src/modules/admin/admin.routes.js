import { Router } from 'express'

import { config } from '../../config/index.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { parseBearer } from '../auth/auth.middleware.js'
import {
  getFeedbackDetail,
  listFeedback,
  updateFeedback,
} from '../feedback/feedback.service.js'
import { dictionary, loadedAt } from '../dictionary/dictionary.loader.js'
import logRoutes from '../logs/log.routes.js'
import { getAiRuntimeSnapshot } from '../readings/ai.client.js'
import { getGenerationRuntimeSnapshot } from '../readings/generation-task.service.js'
import { recordAdminAudit } from './admin-audit.service.js'
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

// 访问 / 报错日志查询（md/53）：里面有 IP，只能挂在 requireAdmin 后面
router.use('/logs', logRoutes)

router.get('/overview', async (req, res) => {
  res.json(await getOverview())
})

/**
 * 运行态（md/45 L7）：原先是 `/api/health` 的一部分，但那个接口未认证即可访问。
 * 词库条数、生成队列、上游熔断都是「服务有多满」的信息，只该给管理员看；
 * 探活只需要知道「活着 + 连上库了」。
 */
router.get('/runtime', (req, res) => {
  const generation = getGenerationRuntimeSnapshot()
  const ai = getAiRuntimeSnapshot()

  res.json({
    dictionary: { words: dictionary.size, loadedAt },
    // 不暴露 key、用户或任务 id；这些都是计数与阈值
    generation: {
      active: generation.active,
      queued: generation.queued,
      pending: generation.pending,
      maxActive: generation.maxActive,
      maxQueue: generation.maxQueue,
      upstreamActive: ai.upstreamActive,
      upstreamWaiting: ai.upstreamWaiting,
      circuit: ai.circuit,
    },
  })
})

router.get('/users', async (req, res) => {
  const query = parseOrThrow(adminUsersQuerySchema, req.query)

  res.json(await listUsers(query))
})

router.get('/users/:dataKey', async (req, res) => {
  const { dataKey } = req.params

  // 详情页给全量手机号，属于隐私访问：必须留痕（§6）。
  // 落库而不是只打 stdout——进程一重启终端日志就没了，
  // 出事时既证明不了看过、也证明不了没看过（md/45 §10.1）
  await recordAdminAudit({
    admin: req.admin.username,
    action: 'user.detail',
    target: dataKey,
    ip: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
    requestId: req.id ?? '',
  })

  res.json(await getUserDetail({ dataKey }))
})

router.get('/feedback', async (req, res) => {
  const query = parseOrThrow(adminFeedbackQuerySchema, req.query)

  res.json(await listFeedback(query))
})

router.get('/feedback/:id', async (req, res) => {
  // 详情带完整手机号与联系方式，跟用户详情同一性质，同样要留痕（md/45 §10.1）
  await recordAdminAudit({
    admin: req.admin.username,
    action: 'feedback.detail',
    target: req.params.id,
    ip: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
    requestId: req.id ?? '',
  })

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
