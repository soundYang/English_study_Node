import { z } from 'zod'

export const LEVELS = ['easy', 'medium', 'hard']
export const QUESTION_COUNTS = [3, 5, 8]

/** 历史列表允许的 level 取值，all = 不筛选 */
export const HISTORY_LEVEL_FILTERS = ['all', ...LEVELS]

/**
 * POST /api/readings/generate 的请求体。
 * 约束与前端 unit/validators.js 完全一致——前端已经限过一遍，
 * 但接口是公开的，后端必须再校验一次。
 */
export const generateReadingSchema = z.object({
  level: z.enum(LEVELS, { error: 'level 只能是 easy / medium / hard' }),
  targetWords: z
    .number({ error: 'targetWords 必须是数字' })
    .int('targetWords 必须是整数')
    .min(50, 'targetWords 最小为 50')
    .max(300, 'targetWords 最大为 300')
    .refine((value) => value % 10 === 0, 'targetWords 必须是 10 的倍数'),
  questionCount: z
    .number({ error: 'questionCount 必须是数字' })
    .int('questionCount 必须是整数')
    .refine(
      (value) => QUESTION_COUNTS.includes(value),
      'questionCount 只能是 3 / 5 / 8',
    ),
})

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
