import { badRequest } from '../errors.js'

/**
 * 用 zod 校验并直接抛业务异常。
 * 只取第一条 issue：前端一次只展示一个字段错误，堆一串反而看不清。
 *
 * @param {import('zod').ZodTypeAny} schema
 * @param {unknown} data
 */
export function parseOrThrow(schema, data) {
  const result = schema.safeParse(data)

  if (result.success) return result.data

  const issue = result.error.issues[0]
  const field = issue.path.length > 0 ? String(issue.path[0]) : ''

  throw badRequest(issue.message, field)
}
