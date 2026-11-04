import { z } from 'zod'

export const wordBankListSchema = z.object({
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
    .default(50),
  q: z.string({ error: '搜索词必须是字符串' }).max(50).default(''),
  // imported / not_imported 看的是导入记录，不是“在不在个人词库”
  filter: z.enum(['all', 'imported', 'not_imported'], {
    error: 'filter 只能是 all / imported / not_imported',
  }).default('all'),
})

export const addWordsToBankSchema = z
  .object({
    words: z
      .array(z.string({ error: '单词必须是字符串' }).trim().min(1).max(45))
      .max(500, '一次最多 500 个词')
      .default([]),
    all: z.boolean({ error: 'all 必须是布尔值' }).default(false),
    limit: z.coerce
      .number({ error: 'limit 必须是数字' })
      .int('limit 必须是整数')
      .min(1, 'limit 必须大于等于 1')
      .max(500, 'limit 最大为 500')
      .default(500),
    cursor: z.coerce
      .number({ error: 'cursor 必须是数字' })
      .int('cursor 必须是整数')
      .min(0, 'cursor 不能为负数')
      .default(0),
    status: z.enum(['new', 'learning'], {
      error: 'status 只能是 new / learning',
    }).default('learning'),
  })
  .refine((value) => value.all || value.words.length > 0, {
    message: 'words 不能为空',
    path: ['words'],
  })

export const bankStatusSchema = z.object({
  words: z
    .array(z.string({ error: '单词必须是字符串' }).trim().min(1).max(45))
    .min(1, '至少选择 1 个词')
    .max(200, '一次最多 200 个词'),
  target: z.enum(['new', 'learning', 'mastered', 'removed', 'restore'], {
    error: 'target 只能是 new / learning / mastered / removed / restore',
  }),
  dryRun: z.boolean({ error: 'dryRun 必须是布尔值' }).default(false),
})

export const resetBankSchema = z.object({
  confirm: z.literal(true, { error: '请确认重置该词库' }),
})
