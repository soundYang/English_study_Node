import { z } from 'zod'

import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from '../feedback/feedback.model.js'

/** 管理端请求体与查询参数（md/37 §5.2） */

export const adminLoginSchema = z.object({
  username: z
    .string({ error: '请输入账号' })
    .trim()
    .min(1, '请输入账号')
    .max(64, '账号最多 64 个字符'),
  password: z
    .string({ error: '请输入密码' })
    .min(1, '请输入密码')
    .max(128, '密码最多 128 个字符'),
})

const pageRule = z.coerce
  .number({ error: '页码不正确' })
  .int('页码不正确')
  .min(1, '页码从 1 开始')
  .default(1)

const sizeRule = z.coerce
  .number({ error: '每页数量不正确' })
  .int('每页数量不正确')
  .min(1, '每页至少 1 条')
  .max(100, '每页最多 100 条')
  .default(20)

export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(64, '搜索词最多 64 个字符').optional().default(''),
  page: pageRule,
  size: sizeRule,
  sort: z.enum(['createdAt', 'lastLoginAt', 'tokens', 'readings'], {
    error: '排序方式不正确',
  }).default('createdAt'),
})

export const adminFeedbackQuerySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES, { error: '状态不正确' }).optional(),
  category: z.enum(FEEDBACK_CATEGORIES, { error: '分类不正确' }).optional(),
  page: pageRule,
  size: sizeRule,
})

export const adminFeedbackPatchSchema = z
  .object({
    status: z.enum(['replied', 'closed'], { error: '状态只能改成已回复或已关闭' }).optional(),
    reply: z.string({ error: '回复内容格式不正确' }).trim().max(2000, '回复最多 2000 个字符').optional(),
  })
  .refine((body) => body.status !== 'replied' || Boolean(body.reply), {
    message: '标记为已回复时必须填写回复内容',
    path: ['reply'],
  })
  .refine((body) => body.status !== undefined || body.reply !== undefined, {
    message: '没有要修改的内容',
    path: ['status'],
  })
