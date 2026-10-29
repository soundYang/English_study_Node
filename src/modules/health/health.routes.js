import { Router } from 'express'
import mongoose from 'mongoose'

const router = Router()

/**
 * GET /api/health
 *
 * 只回答「进程活着、库连上了」这一件事（md/45 L7）。
 *
 * 原先这里还附带词库条数、生成队列与上游熔断状态。这个接口**未认证即可访问**，
 * 等于把容量上限与当前负载对所有人开放：谁都能算出一个「该在什么时候打最疼」。
 * 运行态挪到了 `GET /api/admin/runtime`（需要管理员令牌）。
 *
 * 词库加载失败会在启动阶段直接抛错退出，不会走到这里——
 * 一个「词库空的但服务还在跑」的状态没有意义。
 */
router.get('/health', (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1

  res.status(mongoOk ? 200 : 503).json({
    status: mongoOk ? 'ok' : 'degraded',
    mongo: mongoOk ? 'connected' : 'disconnected',
  })
})

export default router
