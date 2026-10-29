import { Router } from 'express'
import multer from 'multer'

import { badRequest, payloadTooLarge } from '../../shared/errors.js'
import { createIpLimiter } from '../../shared/middleware/rateLimit.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { extractWordsFromFile } from './import/index.js'
import { MAX_FILE_BYTES } from './import/limits.js'
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

/**
 * 文件解析是**纯 CPU** 操作（解压 + XML 解析，图片还要跑 OCR），
 * 比任何读接口都贵得多，所以单独一个更紧的桶（md/48 §5.4）。
 * 5 次/分钟对「选错文件重传两次」的正常用户是够的。
 */
const importLimiter = createIpLimiter({
  windowMs: 60_000,
  limit: 5,
  message: '文件解析太频繁：每分钟最多 5 次，请稍后再试',
})

/**
 * multer 的内存存储：文件最大 5MB，处理完立刻随 buffer 释放，**不落盘**。
 * 落盘会带来「临时文件没删干净」和「磁盘被刷满」两个新问题，
 * 而 5MB 以内的内存占用完全可以接受。
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4 },
})

/** multer 的报错要翻译成我们的错误体系，否则会掉到 500 */
function singleFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next()

    if (error.code === 'LIMIT_FILE_SIZE') return next(payloadTooLarge(MAX_FILE_BYTES))
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(badRequest('文件字段名必须是 file', 'file'))
    }

    return next(error)
  })
}

/**
 * busboy 默认按 latin1 解文件名，中文名会变成乱码。
 * 先按 latin1→utf8 重解一次，解出替换字符就说明本来就不是这个编码，退回原值。
 */
function readFileName(file) {
  const raw = String(file?.originalname ?? '')

  if (!raw) return ''

  const decoded = Buffer.from(raw, 'latin1').toString('utf8')

  return decoded.includes('�') ? raw : decoded
}

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

/**
 * 文件抽取（md/48）：只解析，不写库。
 * 用户确认抽取结果后再调 `POST /api/words/batch` 落库——
 * 写路径只有一条，重复词 / 词库补全 / 上限全部沿用 batch 的规则。
 */
router.post('/import/extract', importLimiter, singleFile, async (req, res) => {
  if (!req.file) throw badRequest('请选择要导入的文件', 'file')

  res.json(
    await extractWordsFromFile({
      buffer: req.file.buffer,
      fileName: readFileName(req.file),
    }),
  )
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
