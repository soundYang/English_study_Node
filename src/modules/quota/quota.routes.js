import { Router } from 'express'

import { getBudgetStatus } from '../budget/budget.service.js'
import { getQuotaSnapshot, quotaIdentityFromRequest } from './quota.service.js'

const router = Router()

/**
 * GET /api/quota（md/35 §7.1）。
 *
 * **公开、不挂限流**：一次 find，不花钱；而且未登录用户也需要知道
 * 「这台设备今天还有没有次数」——挂 requireAuth 的话，匿名生成能跑、
 * 额度查询反而 401，前端没法显示剩余次数。
 */
router.get('/', async (req, res) => {
  // freeBudget 单独取（md/36）：它和身份无关，全站一个计数器。
  // 前端据此在生成前就禁用按钮，而不是等一次 503
  const [quota, freeBudget] = await Promise.all([
    getQuotaSnapshot({ identity: quotaIdentityFromRequest(req) }),
    getBudgetStatus(),
  ])

  res.json({ ...quota, freeBudget })
})

export default router
