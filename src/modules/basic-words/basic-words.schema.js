import { z } from 'zod'

/**
 * GET /api/basic-words 的 query（md/29）。
 *
 * `group` 和 `status` 传未知值**不报 400**，一律按 `all` 处理——
 * 与 `GET /api/words` 对 `status` 的处理保持一致：这两个是筛选器，
 * 前端把旧值留在 URL 里不该让整页变红。
 */
export const listBasicWordsQuerySchema = z.object({
  q: z
    .string({ error: '搜索词必须是字符串' })
    .max(45, '搜索词不能超过 45 个字符')
    .default(''),
  group: z.string({ error: '分组必须是字符串' }).default('all'),
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
    // 默认 50 而不是 /api/words 的 10：基础词页是「浏览」而不是「翻自己的词库」，
    // 650 个词按 10 条分页要翻 65 页，没有可用性
    .default(50),
})
