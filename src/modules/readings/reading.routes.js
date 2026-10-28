import { Router } from 'express'

import { generateRateLimit } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { assertBudgetAvailable } from '../budget/budget.service.js'
import {
  quotaIdentityFromRequest,
  releaseReservation,
  reserveQuota,
} from '../quota/quota.service.js'
import {
  cancelGenerationTask,
  createGenerationTask,
  getGenerationTask,
  retryGenerationTask,
} from './generation-task.service.js'
import { listHistoryQuerySchema } from './reading.schema.js'
import {
  generateReading,
  getCapacity,
  getReading,
  listHistory,
  submitReading,
} from './reading.service.js'

const router = Router()

// 限流只挂这一条（md/21 W9）：挂到 router 上会把 /capacity 一起限掉
router.post('/generate', generateRateLimit, async (req, res) => {
  const controller = new AbortController()

  res.on('close', () => {
    // close 在正常响应结束后也会触发，必须判 writableEnded，
    // 否则每次成功生成都会把一次已经完成的调用 abort 掉（日志里一堆假告警）
    if (!res.writableEnded) controller.abort()
  })

  // 免费池到顶就停（md/36）。放在预扣之前：被预算挡下不该扣当天的额度
  await assertBudgetAvailable()

  // 同步路径没有任务文档可挂，额度用一个局部变量记住，失败时原路退回（md/35 §8.3）
  const reservation = await reserveQuota({ identity: quotaIdentityFromRequest(req) })

  try {
    const dto = await generateReading({
      userId: req.userId,
      body: req.body ?? {},
      signal: controller.signal,
    })

    res.status(201).json(dto)
  } catch (err) {
    // 客户端断开也算「没拿到文章」，额度退回；断开后不写响应，也不该记成 500
    await releaseReservation(reservation)
    if (controller.signal.aborted) return

    throw err
  }
})

/**
 * 任务化生成（md/31）：建任务立刻回 202，进度靠轮询。
 *
 * 限流与 /generate 共用同一个桶——它们花的是同一份模型调用，
 * 分开计数等于把「每分钟最多花 20 次」变成 40 次。任务化的意义是
 * 「看得见、不丢」，不是「可以更频繁地点」。
 */
router.post('/generate/tasks', generateRateLimit, async (req, res) => {
  const { task, reused } = await createGenerationTask({
    userId: req.userId,
    body: req.body ?? {},
    identity: quotaIdentityFromRequest(req),
  })

  res.status(202).json({
    taskId: String(task._id),
    status: task.status,
    stage: task.stage,
    reused,
    params: task.params,
  })
})

router.get('/generate/tasks/:taskId', async (req, res) => {
  res.json(await getGenerationTask({ userId: req.userId, id: req.params.taskId }))
})

/** 取消：只是不再继续付费，已收下的段留着，之后还能 retry 接着写 */
router.post('/generate/tasks/:taskId/cancel', async (req, res) => {
  res.json(await cancelGenerationTask({ userId: req.userId, id: req.params.taskId }))
})

/**
 * 重试：重开同一个任务，只补失败的段（md/31 §11）。
 *
 * 挂限流：它同样会真金白银地调模型，不挂等于给了一个绕过限流的重试入口。
 */
router.post('/generate/tasks/:taskId/retry', generateRateLimit, async (req, res) => {
  const { task, reused } = await retryGenerationTask({
    userId: req.userId,
    id: req.params.taskId,
    identity: quotaIdentityFromRequest(req),
  })

  res.status(202).json({
    taskId: String(task._id),
    status: task.status,
    stage: task.stage,
    reused,
    retryCount: task.retryCount ?? 0,
    params: task.params,
  })
})

// /capacity 与 /history 必须排在 /:id 之前，否则会被当成 id 去查，直接 404
router.get('/capacity', async (req, res) => {
  res.json(await getCapacity({ userId: req.userId, query: req.query }))
})

router.get('/history', async (req, res) => {
  const query = parseOrThrow(listHistoryQuerySchema, req.query)
  res.json(await listHistory({ userId: req.userId, query }))
})

router.post('/:id/submit', async (req, res) => {
  const dto = await submitReading({
    userId: req.userId,
    id: req.params.id,
    body: req.body ?? {},
  })

  res.json(dto)
})

router.get('/:id', async (req, res) => {
  res.json(await getReading({ userId: req.userId, id: req.params.id }))
})

export default router
