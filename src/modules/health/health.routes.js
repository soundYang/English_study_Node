import { Router } from 'express'
import mongoose from 'mongoose'

import { dictionary, loadedAt } from '../dictionary/dictionary.loader.js'

const router = Router()

/**
 * GET /api/health
 *
 * 只有 mongo 连接状态决定 200/503。
 * 词库加载失败会在启动阶段直接抛错退出，不会走到这里——
 * 一个"词库空的但服务还在跑"的状态没有意义。
 */
router.get('/health', (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1

  res.status(mongoOk ? 200 : 503).json({
    status: mongoOk ? 'ok' : 'degraded',
    mongo: mongoOk ? 'connected' : 'disconnected',
    dictionary: { words: dictionary.size, loadedAt },
  })
})

export default router
