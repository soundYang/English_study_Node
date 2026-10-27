import { Router } from 'express'

import { parseOrThrow } from '../../shared/utils/validation.js'
import { listWordsQuerySchema } from './word.schema.js'
import {
  createWord,
  deleteWord,
  listWords,
  updateWord,
} from './word.service.js'

const router = Router()

// Express 5 会自动把 async 函数的 rejection 交给 errorHandler，
// 不需要再包一层 asyncHandler。
router.get('/', async (req, res) => {
  const query = parseOrThrow(listWordsQuerySchema, req.query)
  res.json(await listWords({ userId: req.userId, query }))
})

router.post('/', async (req, res) => {
  const dto = await createWord({ userId: req.userId, body: req.body ?? {} })
  res.status(201).json(dto)
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
