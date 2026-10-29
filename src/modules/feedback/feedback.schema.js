import { z } from 'zod'

import { FEEDBACK_CATEGORIES } from './feedback.model.js'

/**
 * 用户提交反馈的请求体（md/37 §5.1）。
 *
 * **content 只校验类型，不在这里卡长度**：长度错误必须返回
 * `FEEDBACK_TOO_SHORT` / `FEEDBACK_TOO_LONG` 而不是通用的 `INVALID_REQUEST`，
 * 前端要靠它显示「还差几个字」。长度判断在 feedback.service.js 里做。
 */
export const createFeedbackSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES, {
    error: `请选择反馈类型（${FEEDBACK_CATEGORIES.join(' / ')}）`,
  }),
  content: z.string({ error: '请填写反馈内容' }),
  contact: z
    .string({ error: '联系方式格式不正确' })
    .trim()
    .max(100, '联系方式最多 100 个字符')
    .optional()
    .default(''),
  page: z
    .string({ error: '页面路径格式不正确' })
    .trim()
    .max(100, '页面路径最多 100 个字符')
    .optional()
    .default(''),
})
