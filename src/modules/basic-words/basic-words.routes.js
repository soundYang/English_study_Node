import { Router } from 'express'

import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { listBasicWordsQuerySchema } from './basic-words.schema.js'
import {
  listBasicWords,
  removeBasicWord,
  restoreBasicWord,
  setBasicWordState,
} from './basic-words.service.js'

const router = Router()

/**
 * 标记 / 恢复（md/45 M5）：每次只有 1 写，但列表页上一次点几十个词很正常。
 * GET 不挂：切换难度、翻页都靠它，挂紧了会让页面看起来「点不动」。
 */
const markLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 120,
  message: '操作太频繁：每分钟最多 120 次，请稍后再试',
})

/**
 * 基础词页面（md/29）。
 *
 * 三个接口共用一个 `:word` 主键——词形本身就是稳定标识，
 * 词表是静态数据，不存在「同一个词两条记录」的情况。
 */
router.get('/', async (req, res) => {
  const query = parseOrThrow(listBasicWordsQuerySchema, req.query)
  res.json(await listBasicWords({ userId: req.userId, query }))
})

// 标记不认识：写一条 status=new、source=basic-removed 的个人记录
router.delete('/:word', markLimiter, async (req, res) => {
  res.json(await removeBasicWord({ userId: req.userId, word: req.params.word }))
})

// 恢复：删掉那条 basic-removed 记录（md/52 起已废弃，前端改用 PATCH state=none）
router.put('/:word', markLimiter, async (req, res) => {
  res.json(await restoreBasicWord({ userId: req.userId, word: req.params.word }))
})

// 设成指定状态：known 认识 / unknown 不认识 / none 未标记（md/52）
router.patch('/:word', markLimiter, async (req, res) => {
  res.json(
    await setBasicWordState({
      userId: req.userId,
      word: req.params.word,
      body: req.body,
    }),
  )
})

export default router
