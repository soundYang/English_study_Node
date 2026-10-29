import { config } from '../../config/index.js'
import { logger } from '../../shared/logger.js'
import { escapeRegex } from '../../shared/utils/regex.js'
import { AccessLog } from './access-log.model.js'
import { ErrorLog } from './error-log.model.js'

/**
 * 日志落库的读写（md/53）。
 *
 * 写操作是**尽力而为**：日志写失败绝不能影响请求本身，所以不 await、
 * 失败只再打一行终端 warn。读操作只给管理端用。
 */

/** 一次请求一条；由 accessLog 中间件在响应结束时调用 */
export function recordAccess(entry) {
  if (!config.accessLogEnabled) return

  AccessLog.create(entry).catch((err) => {
    logger.warn({ err }, 'access log write failed')
  })
}

/** 未处理异常（5xx）；由 errorHandler 调用 */
export function recordError(entry) {
  if (!config.errorLogEnabled) return

  ErrorLog.create(entry).catch((err) => {
    logger.warn({ err }, 'error log write failed')
  })
}

function toAccessDto(doc) {
  return {
    id: String(doc._id),
    createdAt: doc.createdAt,
    method: doc.method,
    path: doc.path,
    statusCode: doc.statusCode,
    durationMs: doc.durationMs,
    ip: doc.ip,
    userId: doc.userId,
    userAgent: doc.userAgent,
    origin: doc.origin,
    requestId: doc.requestId,
  }
}

function toErrorDto(doc) {
  return {
    id: String(doc._id),
    createdAt: doc.createdAt,
    requestId: doc.requestId,
    method: doc.method,
    path: doc.path,
    statusCode: doc.statusCode,
    code: doc.code,
    message: doc.message,
    stack: doc.stack,
    ip: doc.ip,
    userId: doc.userId,
    userAgent: doc.userAgent,
  }
}

/**
 * GET /api/admin/logs/access
 *
 * `ip` / `userId` 是精确匹配，`path` 是包含匹配（转义后按字面量）。
 * 默认按时间倒序，与「先看最近发生了什么」的用法一致。
 */
export async function listAccessLogs({
  page = 1,
  size = 20,
  ip = '',
  userId = '',
  status,
  path = '',
} = {}) {
  const filter = {}
  if (ip) filter.ip = ip
  if (userId) filter.userId = userId
  if (status !== undefined) filter.statusCode = status
  if (path) filter.path = new RegExp(escapeRegex(path), 'i')

  const [rows, total] = await Promise.all([
    AccessLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * size)
      .limit(size)
      .lean(),
    AccessLog.countDocuments(filter),
  ])

  return { total, page, size, items: rows.map(toAccessDto) }
}

/** GET /api/admin/logs/errors；`code` 精确匹配，`ip` 精确匹配 */
export async function listErrorLogs({ page = 1, size = 20, ip = '', code = '' } = {}) {
  const filter = {}
  if (ip) filter.ip = ip
  if (code) filter.code = code

  const [rows, total] = await Promise.all([
    ErrorLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * size)
      .limit(size)
      .lean(),
    ErrorLog.countDocuments(filter),
  ])

  return { total, page, size, items: rows.map(toErrorDto) }
}
