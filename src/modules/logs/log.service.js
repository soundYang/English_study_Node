import { config } from '../../config/index.js'
import { logger } from '../../shared/logger.js'
import { escapeRegex } from '../../shared/utils/regex.js'
import { AccessLog } from './access-log.model.js'
import { ErrorLog } from './error-log.model.js'
import { LoginRecord } from './login-log.model.js'

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

/**
 * 一次登录 / 注册尝试；由 auth.service / admin.service 调用。
 *
 * 失败也要记：爆破目标的用户名与来源 IP 是安全排查最重要的两条线索。
 * 截断放在这里统一做，调用方不需要关心字段长度。
 */
export function recordLogin({
  userId = '',
  username = '',
  role,
  success,
  ip = '',
  userAgent = '',
}) {
  if (!config.loginLogEnabled) return

  LoginRecord.create({
    userId: String(userId ?? '').slice(0, 100),
    username: String(username ?? '').slice(0, 100),
    role,
    success: Boolean(success),
    ip: String(ip ?? '').slice(0, 64),
    userAgent: String(userAgent ?? '').slice(0, 300),
  }).catch((err) => {
    logger.warn({ err }, 'login log write failed')
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

function toLoginDto(doc) {
  return {
    id: String(doc._id),
    createdAt: doc.createdAt,
    userId: doc.userId,
    username: doc.username,
    role: doc.role,
    success: doc.success,
    ip: doc.ip,
    userAgent: doc.userAgent,
  }
}

/** `from` / `to` 都是可选；只给一端也能用（「只看今天」「只看某时刻之后」） */
function applyTimeRange(filter, from, to) {
  if (!from && !to) return

  filter.createdAt = {}
  if (from) filter.createdAt.$gte = from
  if (to) filter.createdAt.$lte = to
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
  from,
  to,
} = {}) {
  const filter = {}
  if (ip) filter.ip = ip
  if (userId) filter.userId = userId
  if (status !== undefined) filter.statusCode = status
  if (path) filter.path = new RegExp(escapeRegex(path), 'i')
  applyTimeRange(filter, from, to)

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
export async function listErrorLogs({
  page = 1,
  size = 20,
  ip = '',
  code = '',
  path = '',
  from,
  to,
} = {}) {
  const filter = {}
  if (ip) filter.ip = ip
  if (code) filter.code = code
  if (path) filter.path = new RegExp(escapeRegex(path), 'i')
  applyTimeRange(filter, from, to)

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

/**
 * GET /api/admin/logs/logins
 *
 * 成功与失败都返回；`success` 由前端显式传 `true` / `false` 过滤。
 * `userId` 是 dataKey（与访问日志同一口径），失败记录里为空；
 * 管理员登录的 `userId` 同样为空，用 `role` + `username` 区分。
 */
export async function listLoginLogs({
  page = 1,
  size = 20,
  ip = '',
  userId = '',
  username = '',
  role,
  success,
  from,
  to,
} = {}) {
  const filter = {}
  if (ip) filter.ip = ip
  if (userId) filter.userId = userId
  if (username) filter.username = new RegExp(escapeRegex(username), 'i')
  if (role) filter.role = role
  if (success !== undefined) filter.success = success === 'true'
  applyTimeRange(filter, from, to)

  const [rows, total] = await Promise.all([
    LoginRecord.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * size)
      .limit(size)
      .lean(),
    LoginRecord.countDocuments(filter),
  ])

  return { total, page, size, items: rows.map(toLoginDto) }
}

/**
 * GET /api/admin/logs/summary
 *
 * 管理端首页的数字卡：不需要把整表拉给前端再数一遍。
 * 只统计最近 `days` 天；访问日志按状态码分三档（2xx / 4xx / 5xx），
 * 报错日志给 Top 10 错误码，登录记录给成功 / 失败与用户数。
 */
export async function summarizeLogs({ days = 7 } = {}) {
  const now = new Date()
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const range = { createdAt: { $gte: since } }

  const [
    accessTotal,
    accessOk,
    accessClientError,
    accessServerError,
    ips,
    errorTotal,
    errorByCode,
    loginTotal,
    loginFailed,
    loginUsers,
    loginRoles,
  ] = await Promise.all([
    AccessLog.countDocuments(range),
    AccessLog.countDocuments({ ...range, statusCode: { $lt: 400 } }),
    AccessLog.countDocuments({ ...range, statusCode: { $gte: 400, $lt: 500 } }),
    AccessLog.countDocuments({ ...range, statusCode: { $gte: 500 } }),
    // distinct 会把 '' 也算进来，显式排除
    AccessLog.distinct('ip', { ...range, ip: { $ne: '' } }),
    ErrorLog.countDocuments(range),
    ErrorLog.aggregate([
      { $match: range },
      { $group: { _id: '$code', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 10 },
    ]),
    LoginRecord.countDocuments(range),
    LoginRecord.countDocuments({ ...range, success: false }),
    LoginRecord.distinct('userId', { ...range, userId: { $ne: '' } }),
    LoginRecord.aggregate([{ $match: range }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
  ])

  const byRole = { user: 0, admin: 0 }
  for (const row of loginRoles) {
    if (row._id in byRole) byRole[row._id] = row.count
  }

  return {
    range: { days, from: since.toISOString(), to: now.toISOString() },
    access: {
      total: accessTotal,
      ok: accessOk,
      clientError: accessClientError,
      serverError: accessServerError,
      uniqueIps: ips.length,
    },
    errors: {
      total: errorTotal,
      byCode: errorByCode.map((row) => ({ code: row._id, count: row.count })),
    },
    logins: {
      total: loginTotal,
      failed: loginFailed,
      uniqueUsers: loginUsers.length,
      byRole,
    },
  }
}
