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

/**
 * 时间范围：前端传 ISO 字符串（`2026-10-29T00:00:00.000Z`）。
 * 空串当作「没传」，否则日期输入框清空后会把整个查询打成 400。
 */
const dateRule = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.coerce.date({ error: '时间格式不正确，应为 ISO 时间' }).optional(),
)

/** 同一套规则给三个列表用：只给一端也行 */
const timeRange = { from: dateRule, to: dateRule }

/** from > to 时返回 400，而不是悄悄返回空列表 */
function checkRange(query) {
  return !query.from || !query.to || query.from <= query.to
}

const rangeMessage = { message: '开始时间不能晚于结束时间', path: ['from'] }

export const accessLogQuerySchema = z
  .object({
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
    ...timeRange,
  })
  .refine(checkRange, rangeMessage)

export const errorLogQuerySchema = z
  .object({
    page: pageRule,
    size: sizeRule,
    ip: z.string({ error: 'ip 必须是字符串' }).trim().max(64).default(''),
    code: z.string({ error: 'code 必须是字符串' }).trim().max(100).default(''),
    // 错误也可能集中在某条路径上，页面通常需要和访问日志一样的筛选
    path: z.string({ error: 'path 必须是字符串' }).trim().max(100).default(''),
    ...timeRange,
  })
  .refine(checkRange, rangeMessage)

export const loginLogQuerySchema = z
  .object({
    page: pageRule,
    size: sizeRule,
    ip: z.string({ error: 'ip 必须是字符串' }).trim().max(64).default(''),
    // 与访问日志同一口径：dataKey；失败记录为空
    userId: z.string({ error: 'userId 必须是字符串' }).trim().max(100).default(''),
    // 用户名包含匹配：管理员想查「谁在试某个账号」
    username: z.string({ error: 'username 必须是字符串' }).trim().max(100).default(''),
    role: z.enum(['user', 'admin'], { error: 'role 只能是 user / admin' }).optional(),
    success: z.enum(['true', 'false'], { error: 'success 只能是 true / false' }).optional(),
    ...timeRange,
  })
  .refine(checkRange, rangeMessage)

export const logSummaryQuerySchema = z.object({
  days: z.coerce
    .number({ error: 'days 必须是数字' })
    .int('days 必须是整数')
    .min(1, 'days 最小为 1')
    .max(90, 'days 最大为 90')
    .default(7),
})
