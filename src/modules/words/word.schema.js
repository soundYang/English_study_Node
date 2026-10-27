import { z } from 'zod'

/** 与前端 unit/validators.js 的 WORD_STATUSES 保持一致 */
export const WORD_STATUSES = ['new', 'learning', 'mastered']

/** 列表接口允许的 status 取值，all = 不筛选 */
export const WORD_STATUS_FILTERS = ['all', ...WORD_STATUSES]

/**
 * GET /api/words 的 query。
 *
 * `_t` 是前端自动附加的时间戳，不在这里声明——zod 默认剥掉未知键，
 * 多一个参数不会报 400。
 */
export const listWordsQuerySchema = z.object({
  q: z
    .string({ error: '搜索词必须是字符串' })
    .max(45, '搜索词不能超过 45 个字符')
    .default(''),
  status: z.string({ error: '状态必须是字符串' }).default('all'),
  page: z.coerce
    .number({ error: '页码必须是数字' })
    .int('页码必须是整数')
    .min(1, '页码必须大于等于 1')
    .default(1),
  pageSize: z.coerce
    .number({ error: '每页数量必须是数字' })
    .int('每页数量必须是整数')
    .min(1, '每页数量最小为 1')
    .max(100, '每页数量最大为 100')
    .default(10),
})

/**
 * POST /api/words 的请求体。
 *
 * `phonetic` / `senses` 声明为 unknown：source=dictionary 时服务端以词库为准，
 * 请求体里这两项一律忽略，声明类型只是为了别让它们触发未知键处理。
 */
export const createWordSchema = z.object({
  word: z.string({ error: '请填写单词' }),
  status: z.string().nullish(),
  source: z.string().nullish(),
  dictionaryId: z.string().nullish(),
  phonetic: z.unknown().nullish(),
  senses: z.unknown().nullish(),
  meaning: z.string({ error: '释义必须是字符串' }).nullish(),
})

/**
 * PATCH /api/words/:id 的请求体。
 *
 * 只声明允许修改的三个字段。只读字段的检查放在 zod 之前，
 * 因为 zod 会把 source / dictionaryId / phonetic / senses 直接剥掉，
 * 剥完再查就永远查不到“用户试图改只读字段”了。
 */
export const updateWordSchema = z.object({
  word: z.string({ error: '单词必须是字符串' }).optional(),
  status: z.string({ error: '状态必须是字符串' }).optional(),
  meaning: z.string({ error: '释义必须是字符串' }).optional(),
})
