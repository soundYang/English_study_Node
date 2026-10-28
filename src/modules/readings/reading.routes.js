import { Router } from 'express'

import { generateRateLimit } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import {
  createGenerationTask,
  getGenerationTask,
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

  try {
    const dto = await generateReading({
      userId: req.userId,
      body: req.body ?? {},
      signal: controller.signal,
    })

    res.status(201).json(dto)
  } catch (err) {
    // 客户端已经断开，再写响应没有意义，也不该记成 500
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
