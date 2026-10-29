import { Router } from 'express'
import mongoose from 'mongoose'

import { dictionary, loadedAt } from '../dictionary/dictionary.loader.js'
import { getGenerationRuntimeSnapshot } from '../readings/generation-task.service.js'
import { getAiRuntimeSnapshot } from '../readings/ai.client.js'

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

  const generation = getGenerationRuntimeSnapshot()
  const ai = getAiRuntimeSnapshot()

  res.status(mongoOk ? 200 : 503).json({
    status: mongoOk ? 'ok' : 'degraded',
    mongo: mongoOk ? 'connected' : 'disconnected',
    dictionary: { words: dictionary.size, loadedAt },
    // 纯 additive（md/55 §7.2）：只看 Mongo 决定 200/503，队列满 / 熔断打开
    // 只体现在数字里。不暴露 key、用户或任务 id
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

export default router
