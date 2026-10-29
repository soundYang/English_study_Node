import { Router } from 'express'

import { parseOrThrow } from '../../shared/utils/validation.js'
import { accessLogQuerySchema, errorLogQuerySchema } from './log.schema.js'
import { listAccessLogs, listErrorLogs } from './log.service.js'

/**
 * 管理端日志查询（md/53），挂载在 `/api/admin/logs`。
 *
 * 鉴权由 admin.routes 的 `requireAdmin` 统一管：
 * 访问日志里有 IP 和访问路径，属于隐私数据，不能有第二个入口。
 */
const router = Router()

router.get('/access', async (req, res) => {
  res.json(await listAccessLogs(parseOrThrow(accessLogQuerySchema, req.query)))
})

router.get('/errors', async (req, res) => {
  res.json(await listErrorLogs(parseOrThrow(errorLogQuerySchema, req.query)))
})

export default router
