import { Router } from 'express'

import { searchDictionary } from './dictionary.service.js'

const router = Router()

/**
 * GET /api/dictionary/search?q=aban&limit=8&_t=...
 *
 * `_t` 是前端自动附加的时间戳，这里不读取也不校验，多一个参数不会报 400。
 * 无匹配返回 200 + 空数组，不是 404——前端靠空数组显示「词库未收录」。
 */
router.get('/search', (req, res) => {
  res.json(searchDictionary({ q: req.query.q, limit: req.query.limit }))
})

export default router
