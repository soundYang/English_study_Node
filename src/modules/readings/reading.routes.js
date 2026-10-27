import { Router } from 'express'

import { generateReading } from './reading.service.js'

const router = Router()

router.post('/generate', async (req, res) => {
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

export default router
