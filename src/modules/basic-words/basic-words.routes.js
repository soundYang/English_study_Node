import { Router } from 'express'

import { parseOrThrow } from '../../shared/utils/validation.js'
import { listBasicWordsQuerySchema } from './basic-words.schema.js'
import {
  listBasicWords,
  removeBasicWord,
  restoreBasicWord,
} from './basic-words.service.js'

const router = Router()

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
router.delete('/:word', async (req, res) => {
  res.json(await removeBasicWord({ userId: req.userId, word: req.params.word }))
})

// 恢复：删掉那条 basic-removed 记录
router.put('/:word', async (req, res) => {
  res.json(await restoreBasicWord({ userId: req.userId, word: req.params.word }))
})

export default router
