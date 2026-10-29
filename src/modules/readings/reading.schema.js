import { z } from 'zod'

import { VOCAB_SCOPES, requiredTargetWords } from './vocabulary-pool.js'

export const LEVELS = ['easy', 'medium', 'hard']
export const QUESTION_COUNTS = [3, 5, 8]

/** 历史列表允许的 level 取值，all = 不筛选 */
export const HISTORY_LEVEL_FILTERS = ['all', ...LEVELS]

/**
 * POST /api/readings/generate 的请求体。
 * 约束与前端 unit/validators.js 完全一致——前端已经限过一遍，
 * 但接口是公开的，后端必须再校验一次。
 */
/**
 * targetWords 的取值规则。生成与预检共用同一份，
 * 否则会出现「预检说能生成、点下去 400」。
 *
 * 上限 1000（md/26 → md/30）：契约层放开到 1000，**各档实际上限仍由
 * `LEVEL_LIMITS.maxTargetWords` 决定**（easy 300 / medium 450 / hard 600，
 * hard 在个人词库 ≥ 3000 时进入「最终模式」，上限 1000——见 md/30 §2）。
 * 两层分开的理由：契约管「这个数字合不合法」，档位管「这个难度写不写得动」。
 *
 * 历史上 600 一直是契约层硬上限，因为 800 词实测写不出来——正文需要约 2000 个
 * 高频词才自然，而那次放行词表只有 1697 个（候选池 800 + 基础 600 + 日历词）。
 * 800 词两次全文重写后仍有 40 个表外词（serious / volunteer / business…）。
 * 但那次用的是 easy 档词库。md/26 正在用 hard 档 + 更大个人词库重测这件事，
 * 结论出来前不把 600 写死在契约层，否则永远测不到。
 */
const targetWordsRules = z
  .number({ error: 'targetWords 必须是数字' })
  .int('targetWords 必须是整数')
  .min(100, 'targetWords 最小为 100')
  .max(1000, 'targetWords 最大为 1000')
  .refine((value) => value % 10 === 0, 'targetWords 必须是 10 的倍数')

/**
 * 用户自选词（md/54）。
 *
 * 字符集与 `target-coverage.js` / `vocabulary.service.js` 的词元切分保持一致：
 * 字母开头，允许连字符与撇号。带重音字母、空格词组都不支持——前者进不了切词，
 * 后者不是「一个单词」，词形变化与覆盖度都算不准。
 */
const FOCUS_WORD_RE = /^[A-Za-z][A-Za-z'-]{0,49}$/

/** 小写、去重、保留首次出现顺序。schema 与 capacity 共用同一份，避免两处规则分叉 */
function normalizeFocusWords(list) {
  const seen = new Set()
  const result = []

  for (const item of list) {
    const word = String(item).replace(/’/g, "'").trim().toLowerCase()
    if (!word || seen.has(word)) continue

    seen.add(word)
    result.push(word)
  }

  return result
}

/**
 * 弯撇号在**校验前**就归一成直撇号：`Don’t` 是用户键盘上最常见的形式，
 * 等到 transform 再换已经过不了正则了。
 */
const focusWordSchema = z.preprocess(
  (value) =>
    typeof value === 'string' ? value.replace(/’/g, "'").trim() : value,
  z
    .string({ error: 'focusWords 的每一项必须是字符串' })
    .min(1, 'focusWords 不能包含空字符串')
    .max(50, '单个单词最多 50 个字符')
    .regex(FOCUS_WORD_RE, '单词只能包含英文字母、连字符和撇号')
    .transform((word) => word.toLowerCase()),
)

/**
 * 不传 = 自动；显式 `[]` → 400（与 vocabScope 同一口径）。
 * 上限依赖 targetWords，数量校验放在对象级 superRefine，字段本身只管形状。
 */
const focusWordsField = z
  .array(focusWordSchema, { error: 'focusWords 必须是数组' })
  .min(1, 'focusWords 不能为空数组')
  .max(100, 'focusWords 最多 100 个')
  .transform(normalizeFocusWords)
  .optional()

/**
 * capacity 是 GET，选词只能放在 query 里：逗号分隔（也兼容重复参数）。
 * 空串 `focusWords=` 过滤成 [] = 没有选词——诊断接口不该因为一个空参数挡住整页；
 * 生成接口则把 `[]` 判成 400（md/54 §3.3）。
 */
const capacityFocusWordsField = z.preprocess(
  (value) => {
    if (value === undefined) return undefined

    const list = Array.isArray(value) ? value : String(value).split(',')
    return list.map((item) => String(item).trim()).filter(Boolean)
  },
  z
    .array(focusWordSchema, { error: 'focusWords 必须是逗号分隔的单词' })
    .max(100, 'focusWords 最多 100 个')
    .transform(normalizeFocusWords)
    .optional(),
)

/**
 * 数量上限 = 本次篇幅的目标词配额（md/54 §4.1）。
 *
 * 多选等于让模型把文章写成填词练习，所以宁可 400 也不静默截断——
 * 静默截断会让用户以为所有勾选的词都生效了。
 */
function focusWordsLimitRule(value, ctx) {
  if (!Array.isArray(value.focusWords) || value.focusWords.length === 0) return

  const max = requiredTargetWords(value.targetWords)

  if (value.focusWords.length > max) {
    ctx.addIssue({
      code: 'custom',
      path: ['focusWords'],
      message: `focusWords 最多 ${max} 个（${value.targetWords} 词的文章最多 ${max} 个目标词）`,
    })
  }
}

/**
 * 生成参数的公共字段。`generateReadingSchema` / `createTaskSchema` /
 * `capacityQuerySchema` 共用这一份，避免三处手抄分叉。
 */
const readingShape = {
  level: z.enum(LEVELS, { error: 'level 只能是 easy / medium / hard' }),
  targetWords: targetWordsRules,
  // 词源多选。default 只兜 undefined，显式传 [] 仍会被 min(1) 拦成 400——
  // 这正是契约要的：前端不该发空数组，发了就是前端 bug，宁可报错也别悄悄全选。
  vocabScope: z
    .array(
      z.enum(VOCAB_SCOPES, {
        error: 'vocabScope 只能是 today_new / today_reviewed / all',
      }),
    )
    .min(1, 'vocabScope 不能为空数组')
    .optional()
    .default(['all']),
  questionCount: z
    .number({ error: 'questionCount 必须是数字' })
    .int('questionCount 必须是整数')
    .refine(
      (value) => QUESTION_COUNTS.includes(value),
      'questionCount 只能是 3 / 5 / 8',
    ),
  /**
   * 是否允许偶尔出现少量生词（md/41、md/42）。
   *
   * **不传 = 自动**：最终模式（hard + 篇幅 > 600 + 个人词库 ≥ 3000）默认开，
   * 其余模式默认关；显式 true / false 始终优先。
   * easy 的「0 生词」是卖点，固定不允许（传 true 直接 400）。
   * 语义是「允许」不是「保证」：模型全用熟词也完全合法。
   */
  allowNewWords: z.boolean({ error: 'allowNewWords 必须是布尔值' }).optional(),
  /**
   * 用户显式要求用上的词（md/54）。不传 = 自动；显式 [] 是 400。
   * 词必须在个人词库里（learning / mastered），由 service 在读库后校验——
   * 这里只做形状、归一化与数量上限。
   */
  focusWords: focusWordsField,
}

/** easy 不能开生词容忍：这是难度承诺的一部分，不是参数偏好 */
const allowNewWordsRule = (value) => !(value.allowNewWords && value.level === 'easy')

const ALLOW_NEW_WORDS_MESSAGE = 'easy 难度不支持生词，allowNewWords 只能用于 medium / hard'

export const generateReadingSchema = z
  .object(readingShape)
  .refine(allowNewWordsRule, {
    message: ALLOW_NEW_WORDS_MESSAGE,
    path: ['allowNewWords'],
  })
  .superRefine(focusWordsLimitRule)

/**
 * POST /api/readings/generate/tasks 的请求体（md/31 §3.1）。
 *
 * 生成参数**直接复用** `generateReadingSchema` 的字段，不另抄一份：
 * 上限从 600 改到 1000 那次已经证明，两处手抄的校验一定会分叉。
 *
 * `clientToken` 是前端生成的幂等键。它只在一处起作用——
 * 同一个 token 重复提交只跑一次（双击、网络重发）。故意不设成必填：
 * 没有它也能用「同参数复用」兜住绝大部分重复。
 */
export const createTaskSchema = z
  .object({
    ...readingShape,
    clientToken: z
      .string({ error: 'clientToken 必须是字符串' })
      .trim()
      .min(8, 'clientToken 至少 8 个字符')
      .max(128, 'clientToken 最多 128 个字符')
      .optional(),
  })
  .refine(allowNewWordsRule, {
    message: ALLOW_NEW_WORDS_MESSAGE,
    path: ['allowNewWords'],
  })
  .superRefine(focusWordsLimitRule)

/**
 * GET /api/readings/capacity 的查询参数。
 *
 * 三处差异都由「query 里全是字符串」造成：
 *   targetWords 需要 coerce，再交给 generate 的同一套规则校验；
 *   vocabScope 单值时是字符串、多值时是数组，先统一成数组再复用枚举；
 *   focusWords 用逗号分隔，空串视为「没有选词」（md/54）。
 */
export const capacityQuerySchema = z
  .object({
    targetWords: z
      .coerce.number({ error: 'targetWords 必须是数字' })
      .pipe(targetWordsRules),
    vocabScope: z.preprocess(
      (value) => (value === undefined ? undefined : [].concat(value)),
      readingShape.vocabScope,
    ),
    focusWords: capacityFocusWordsField,
  })
  .superRefine(focusWordsLimitRule)

/**
 * POST /api/readings/:id/submit 的请求体。
 *
 * 前端每道题都会发，未作答的 selectedOption 为 null——null 是合法输入，
 * 判错即可，不能报 400（否则用户没答完就提交会被接口挡住）。
 */
export const submitReadingSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z
        .number({ error: 'questionId 必须是数字' })
        .int('questionId 必须是整数')
        .positive('questionId 必须是正整数'),
      selectedOption: z
        .number({ error: 'selectedOption 必须是数字或 null' })
        .int('selectedOption 必须是整数')
        .min(0, 'selectedOption 必须在 0–3 之间')
        .max(3, 'selectedOption 必须在 0–3 之间')
        .nullable(),
    }),
    { error: 'answers 必须是数组' },
  ),
})

/**
 * GET /api/readings/history 的 query。
 *
 * `_t` 是前端防缓存附加的时间戳，不在这里声明——zod 默认剥掉未知键。
 */
export const listHistoryQuerySchema = z.object({
  level: z.string({ error: '难度必须是字符串' }).default('all'),
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
