import { z } from 'zod'

/** 管理端日志查询参数（md/53） */

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

export const accessLogQuerySchema = z.object({
  page: pageRule,
  size: sizeRule,
  // 精确匹配；IPv6 最长 45，留 64
  ip: z.string({ error: 'ip 必须是字符串' }).trim().max(64, 'ip 最多 64 个字符').default(''),
  userId: z.string({ error: 'userId 必须是字符串' }).trim().max(100).default(''),
  // 包含匹配（按字面量，不把用户输入当正则）
  path: z.string({ error: 'path 必须是字符串' }).trim().max(100).default(''),
  // 不传 = 不过滤。浏览器只能点出 2xx/4xx/5xx 三类，接口仍按具体数字收
  status: z.coerce
    .number({ error: '状态码必须是数字' })
    .int('状态码必须是整数')
    .min(100, '状态码最小为 100')
    .max(599, '状态码最大为 599')
    .optional(),
})

export const errorLogQuerySchema = z.object({
  page: pageRule,
  size: sizeRule,
  ip: z.string({ error: 'ip 必须是字符串' }).trim().max(64).default(''),
  code: z.string({ error: 'code 必须是字符串' }).trim().max(100).default(''),
})
