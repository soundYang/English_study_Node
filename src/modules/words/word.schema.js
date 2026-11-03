import { z } from 'zod'

/** 与前端 unit/validators.js 的 WORD_STATUSES 保持一致 */
export const WORD_STATUSES = ['new', 'learning', 'mastered']

/** 列表接口允许的 status 取值，all = 不筛选 */
export const WORD_STATUS_FILTERS = ['all', ...WORD_STATUSES]

/**
 * 列表接口允许的 `study` 取值（md/22 第 95 行 ① 的结论）。
 *
 * `status` 是数据库口径，`new` 那一档同时装着「今天加的」和「基础词墓碑」，
 * 按它分档标签页怎么叫都不对。`study` 与 `WordDto.studyState` 一一对应，
 * 标签页按它分，文案与徽章同源。
 */
export const WORD_STUDY_FILTERS = ['all', 'new', 'reviewing', 'mastered', 'removed']

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
  // 与 WordDto.studyState 同一套口径（md/22 第 95 行）。传了非 all 的值时优先于 status
  study: z.string({ error: '学习阶段必须是字符串' }).default('all'),
  // 默认不返回基础词墓碑；只有想看「不认识」清单时才打开（study=removed 等价于打开）
  // 不用 z.coerce.boolean()：Boolean('false') 是 true，传 "false" 反而会打开
  includeRemoved: z
    .enum(['true', 'false'], { error: 'includeRemoved 只能是 true / false' })
    .default('false')
    .transform((value) => value === 'true'),
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
  // 重复词处理策略（md/44 §5.3）。默认 auto：占位词升级、同状态幂等，
  // 需要旧语义（409）的调用方显式传 error
  onDuplicate: z.enum(['auto', 'skip', 'error'], {
    error: 'onDuplicate 只能是 auto / skip / error',
  }).default('auto'),
  // 顺带返回 counts / total，让前端添加成功后不必整页重拉（md/44 §5.7）
  includeCounts: z.boolean({ error: 'includeCounts 必须是布尔值' }).default(false),
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

/**
 * POST /api/words/:id/review 的自评请求体（md/56 §7）。
 *
 * 只有两个取值，不做「不传就默认 pass」的兜底：
 * 自评直接决定这个词的复习轮次，猜错的代价比报 400 大得多。
 */
export const reviewWordSchema = z.object({
  result: z.enum(['pass', 'lapse'], {
    error: 'result 只能是 pass 或 lapse',
  }),
})

/**
 * 一次批量自评的上限（md/56 §8.1）。
 *
 * 200 = 一天的复习上限（50）的四倍：既够用户把积压连续清几拨，
 * 又不至于让别人用一个请求刷出几千次写。
 */
export const MAX_REVIEW_BATCH = 200

/** 一次批量改状态的上限（md/61 §4.2）；与批量导入 / 批量自评保持一致 */
export const MAX_STATUS_BATCH = 200

/**
 * 批量改状态允许的目标（md/61 §4.2）。
 *
 * 注意这不是数据库 `status` 的枚举：`removed` 写的是 `source`，
 * `restore` 是从墓碑回到词库。`all` 是筛选，不是目标。
 */
export const WORD_STATUS_TARGETS = [
  'new',
  'learning',
  'mastered',
  'removed',
  'restore',
]

/**
 * POST /api/words/status/batch 的请求体（md/61）。
 *
 * 只收 id：词形可以被 PATCH 改掉，id 才是稳定键。
 * 非法 ObjectId 不在这里报 400——它与「查不到」对外是同一个结果，
 * 由 service 进 `skipped / NOT_FOUND`，一条坏 id 不拖垮整批。
 */
export const batchStatusSchema = z.object({
  ids: z
    .array(z.string({ error: 'id 必须是字符串' }), {
      error: 'ids 必须是字符串数组',
    })
    .min(1, '至少选择 1 个单词')
    .max(MAX_STATUS_BATCH, `一次最多修改 ${MAX_STATUS_BATCH} 个单词`),
  target: z.enum(WORD_STATUS_TARGETS, {
    error: 'target 只能是 new / learning / mastered / removed / restore',
  }),
  dryRun: z.boolean({ error: 'dryRun 必须是布尔值' }).default(false),
})

/**
 * POST /api/words/review/batch 的请求体。
 *
 * 只收 `id`，不收 `word`：词形可以被用户改（PATCH 支持改词），
 * 用词形当键会在改词后指向一个已经不存在的词。`id` 是稳定的。
 */
export const reviewBatchSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string({ error: 'id 必须是字符串' }),
        result: z.enum(['pass', 'lapse'], { error: 'result 只能是 pass 或 lapse' }),
      }),
      { error: 'items 必须是 { id, result } 的数组' },
    )
    .min(1, '至少提供 1 个词')
    .max(MAX_REVIEW_BATCH, `一次最多自评 ${MAX_REVIEW_BATCH} 个词`),
})

/** 一次批量导入的上限（md/44 §5.4）。200 条已覆盖「一整课单词」的极端情况 */
export const MAX_BATCH_WORDS = 200
/** 粘贴文本上限；express.json 是 64kb，留一半给 JSON 结构 */
export const MAX_BATCH_TEXT_LENGTH = 32768

const batchWordSchema = z.object({
  word: z.string({ error: '请填写单词' }),
  status: z.string().nullish(),
  meaning: z.string({ error: '释义必须是字符串' }).nullish(),
  source: z.string().nullish(),
})

/**
 * POST /api/words/batch 的请求体。
 *
 * `words` 与 `text` 二选一：对象数组适合前端编辑好的表格，
 * 文本适合从课本 / 生词本直接粘贴。两者都给时以 `words` 为准。
 */
export const batchWordsSchema = z
  .object({
    words: z
      .array(batchWordSchema, { error: 'words 必须是数组' })
      .max(MAX_BATCH_WORDS, `一次最多导入 ${MAX_BATCH_WORDS} 个单词`)
      .optional(),
    text: z
      .string({ error: 'text 必须是字符串' })
      .max(MAX_BATCH_TEXT_LENGTH, `一次最多粘贴 ${MAX_BATCH_TEXT_LENGTH} 个字符`)
      .optional(),
    status: z.string().nullish(),
    onDuplicate: z.enum(['auto', 'skip', 'error'], {
      error: 'onDuplicate 只能是 auto / skip / error',
    }).default('auto'),
    dryRun: z.boolean({ error: 'dryRun 必须是布尔值' }).default(false),
  })
  .refine(
    (body) => (body.words?.length ?? 0) > 0 || Boolean(body.text?.trim()),
    { message: '请提供 words 或 text', path: ['words'] },
  )

/** POST /api/words/check 的请求体；非法单词不报 400，逐条回结果 */
export const checkWordsSchema = z.object({
  words: z
    .array(z.string({ error: 'words 里只能放字符串' }), { error: 'words 必须是数组' })
    .min(1, '至少提供 1 个单词')
    .max(MAX_BATCH_WORDS, `一次最多检查 ${MAX_BATCH_WORDS} 个单词`),
  status: z.string().nullish(),
})
