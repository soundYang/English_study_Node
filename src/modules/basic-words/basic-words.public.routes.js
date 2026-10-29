import { Router } from 'express'

import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { listBasicWordsQuerySchema } from './basic-words.schema.js'
import { listBasicWords } from './basic-words.service.js'

/**
 * 基础词汇库的游客只读接口（md/50）。
 *
 * 和 `basic-words.routes.js` **故意分成两个文件**：
 *   · 这里只读、不查库、不看令牌；
 *   · 那边的三个路由都假设 `req.userId` 存在。
 *
 * 混在一个 router 里，迟早会出现「前缀不鉴权、逐路由鉴权」的挂法，
 * 然后某天新加一个写接口忘了挂 requireAuth。
 */

const publicLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 60,
  // 650 条按 100/页只要 7 次请求，正常浏览远低于这个数
  message: '请求太频繁：每分钟最多 60 次，请稍后再试',
})

const router = Router()

router.get('/', publicLimiter, async (req, res) => {
  const query = parseOrThrow(listBasicWordsQuerySchema, req.query)

  const result = await listBasicWords({
    // 不读 req.userId：公开接口对所有人返回同一份字节，
    // 这是缓存能生效的前提，也避免了「登录与否看到不同结果」的歧义
    userId: null,
    query,
    personalized: false,
  })

  // 词表来自构建产物，只有发版才会变；5 分钟挡住翻页时的重复请求
  res.set('Cache-Control', 'public, max-age=300')
  res.json(result)
})

export default router
