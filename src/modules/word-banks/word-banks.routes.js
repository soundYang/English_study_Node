import { Router } from 'express'

import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import {
  addWordsToBank,
  listWordBankWords,
  listWordBanks,
  parseBank,
  resetWordBank,
  updateBankWordsStatus,
} from './word-banks.service.js'

const router = Router()

/**
 * 词库写操作：整库导入按 500/批循环，高频 5 次、中频 9 次，
 * 再加上批量改状态，20 次/分钟仍有余量。
 */
const bankLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 20,
  message: '词库操作太频繁：每分钟最多 20 次，请稍后再试',
})

/** 重置会批量删词，单独用更紧的桶 */
const bankResetLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 5,
  message: '重置太频繁：请稍后再试',
})

router.get('/', async (req, res) => {
  res.json(await listWordBanks({ userId: req.userId }))
})

router.get('/:bank/words', async (req, res) => {
  const bank = parseBank(req.params.bank)
  res.json(
    await listWordBankWords({
      userId: req.userId,
      bank,
      query: req.query,
    }),
  )
})

router.post('/:bank/add', bankLimiter, async (req, res) => {
  const bank = parseBank(req.params.bank)
  res.json(
    await addWordsToBank({
      userId: req.userId,
      bank,
      body: req.body ?? {},
    }),
  )
})

router.post('/:bank/status/batch', bankLimiter, async (req, res) => {
  const bank = parseBank(req.params.bank)
  res.json(
    await updateBankWordsStatus({
      userId: req.userId,
      bank,
      body: req.body ?? {},
    }),
  )
})

router.post('/:bank/reset', bankResetLimiter, async (req, res) => {
  const bank = parseBank(req.params.bank)
  res.json(
    await resetWordBank({
      userId: req.userId,
      bank,
      body: req.body ?? {},
    }),
  )
})

export default router
