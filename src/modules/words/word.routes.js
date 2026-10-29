import { Router } from 'express'

import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { checkWords, importWords } from './word-batch.service.js'
import { listWordsQuerySchema } from './word.schema.js'
import {
  createWord,
  deleteWord,
  listWords,
  updateWord,
} from './word.service.js'

const router = Router()

/**
 * 预检是批量读接口：一次能查 200 个词，被脚本当成「词库探测」时耗的是 CPU。
 * 60 次/分钟/IP 对正常录入（一次粘贴一屏）绰绰有余。
 * 限流总开关跟随 RATE_LIMIT_ENABLED，测试环境默认关闭。
 */
const checkLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 60,
  message: '预检太频繁：每分钟最多 60 次，请稍后再试',
})

// Express 5 会自动把 async 函数的 rejection 交给 errorHandler，
// 不需要再包一层 asyncHandler。

// 批量与预检必须放在 /:id 之前（md/44 §9.2）：
// 现在虽然没有 POST /:id，但保持「静态路径先挂」的惯例，以后加也不会踩坑
router.post('/batch', async (req, res) => {
  res.json(await importWords({ userId: req.userId, body: req.body ?? {} }))
})

router.post('/check', checkLimiter, async (req, res) => {
  res.json(await checkWords({ userId: req.userId, body: req.body ?? {} }))
})

router.get('/', async (req, res) => {
  const query = parseOrThrow(listWordsQuerySchema, req.query)
  res.json(await listWords({ userId: req.userId, query }))
})

router.post('/', async (req, res) => {
  const { dto, created } = await createWord({
    userId: req.userId,
    body: req.body ?? {},
  })

  // 重复词被合并时是 200：响应体仍是 WordDto，客户端靠状态码区分
  res.status(created ? 201 : 200).json(dto)
})

router.patch('/:id', async (req, res) => {
  const dto = await updateWord({
    userId: req.userId,
    id: req.params.id,
    body: req.body ?? {},
  })
  res.json(dto)
})

router.delete('/:id', async (req, res) => {
  res.json(await deleteWord({ userId: req.userId, id: req.params.id }))
})

export default router
