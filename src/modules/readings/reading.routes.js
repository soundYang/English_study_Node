import { Router } from 'express'

import { config } from '../../config/index.js'
import { generationTimeout } from '../../shared/errors.js'
import {
  generateIpRateLimit,
  generateRateLimit,
} from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { resolveAiKey } from '../ai-keys/ai-key.service.js'
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
  scheduler,
  toTaskParams,
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

// 限流只挂生成三条（md/21 W9）：挂到 router 上会把 /capacity 一起限掉。
// 顺序是先 IP 安全桶、再身份桶（md/55 §4.9）：设备 ID 是客户端可控的，
// 只靠身份桶会被轮换设备 ID 绕过；IP 桶兜住这类请求，身份桶负责 NAT 后的公平性。
router.post('/generate', generateIpRateLimit, generateRateLimit, async (req, res) => {
  const controller = new AbortController()

  res.on('close', () => {
    // close 在正常响应结束后也会触发，必须判 writableEnded，
    // 否则每次成功生成都会把一次已经完成的调用 abort 掉（日志里一堆假告警）
    if (!res.writableEnded) controller.abort()
  })

  // md/43：本次生成用哪把 Key。入口解析一次，整条链路共用
  const aiKey = await resolveAiKey(req.userId)

  // 同步路径没有任务文档可挂，额度用一个局部变量记住，失败时原路退回（md/35 §8.3）。
  // 自备 Key 不预扣，reservation 为 null，release 是 no-op
  let reservation = null
  let timeout = null

  try {
    // 同步接口与任务共用同一个执行槽计数器（md/55 §4.2）：
    // 等不到槽就 503，避免几十个 HTTP 连接一起挂着。
    // 额度预扣放在拿到槽之后：排队等待不该占掉用户今天的一次。
    const dto = await scheduler.runSync(async () => {
      // 两道闸只对免费 Key 生效（md/43 §6.2）：自备 Key 花的是用户自己的钱，
      // 不该挤占全站免费池，也不该消耗他自己的每日次数
      if (aiKey.source === 'free') {
        // 免费池到顶就停（md/36）。放在预扣之前：被预算挡下不该扣当天的额度
        await assertBudgetAvailable()
      }

      reservation = aiKey.source === 'free'
        ? await reserveQuota({ identity: quotaIdentityFromRequest(req) })
        : null

      // deadline 从拿到执行槽开始算；排队等待不消耗生成时间（md/55 §4.7）
      timeout = AbortSignal.timeout(config.generationDeadlineMs)
      const signal = AbortSignal.any([controller.signal, timeout])

      const result = await generateReading({
        userId: req.userId,
        body: req.body ?? {},
        signal,
        aiKey,
      })

      // 打桩客户端 / 已经返回但 signal 已到期的慢请求：不能当成功
      if (timeout.aborted) {
        throw generationTimeout({ deadlineMs: config.generationDeadlineMs })
      }

      return result
    }, { signal: controller.signal })

    res.status(201).json(dto)
  } catch (err) {
    // 客户端断开也算「没拿到文章」，额度退回；断开后不写响应，也不该记成 500
    await releaseReservation(reservation)
    reservation = null
    if (controller.signal.aborted) return

    // deadline 与上游错误要分开报：前者是 504、可重试，后者维持原错误
    if (timeout?.aborted) throw generationTimeout({ deadlineMs: config.generationDeadlineMs })

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
router.post('/generate/tasks', generateIpRateLimit, generateRateLimit, async (req, res) => {
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
    // 显式回显三态：null = 没传（自动），false / true = 用户的选择（md/42）
    params: toTaskParams(task),
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
router.post('/generate/tasks/:taskId/retry', generateIpRateLimit, generateRateLimit, async (req, res) => {
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
