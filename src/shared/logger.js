import { config } from '../config/index.js'

/**
 * 终端可读日志（2026-10-29 替换 pino 的 JSON 行输出）。
 *
 * 之前 pino 默认把每条日志打成一行 JSON：
 *   {"level":30,"time":...,"pid":...,"hostname":...,"req":{...},"res":{...}}
 *
 * 终端里看不出前端到底调了什么，也看不出哪一步失败。这里只做一件事：
 * 每个请求打一行「时间 方法 路径 状态 耗时 用户」，其余业务日志打成
 * 「时间 级别 文案 {少量上下文}」。错误会把堆栈接在后面。
 *
 * 接口沿用 pino 的用法，调用方不用改：
 *   logger.info('文案')
 *   logger.warn({ taskId }, '文案')
 *   logger.error({ err }, '文案')
 *
 * 测试环境完全静音（config.nodeEnv === 'test'），否则每个用例都会刷屏。
 */

const isTest = config.nodeEnv === 'test'
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const COLORS = {
  gray: '90',
  green: '32',
  yellow: '33',
  red: '31',
  cyan: '36',
}

function paint(color, text) {
  return useColor ? `\u001b[${COLORS[color]}m${text}\u001b[0m` : String(text)
}

/** 本地时间 HH:MM:SS，比 ISO 时间戳短且一眼能读 */
function time() {
  return new Date().toTimeString().slice(0, 8)
}

/**
 * pino 风格的参数：(`{ 上下文 }, '文案'`) 或 (`'文案'`)。
 * 上下文里的 err / error 单独取出来打堆栈，其余键值压成一段 JSON。
 */
function emit(args, label, color) {
  if (isTest) return

  let payload
  let message = ''

  if (typeof args[0] === 'string') {
    message = args[0]
  } else {
    payload = args[0]
    message = typeof args[1] === 'string' ? args[1] : ''
  }

  const chunks = [paint('gray', time()), paint(color, label.padEnd(5)), message]

  if (payload && typeof payload === 'object') {
    const { err, error, ...rest } = payload
    const cause = err ?? error

    if (Object.keys(rest).length > 0) chunks.push(JSON.stringify(rest))
    if (cause) chunks.push(String(cause.stack ?? cause.message ?? cause))
  } else if (payload != null) {
    chunks.push(String(payload))
  }

  const line = chunks.filter(Boolean).join(' ')
  const stream = label === 'ERROR' || label === 'WARN' ? process.stderr : process.stdout
  stream.write(`${line}\n`)
}

export const logger = {
  info: (...args) => emit(args, 'INFO', 'cyan'),
  warn: (...args) => emit(args, 'WARN', 'yellow'),
  error: (...args) => emit(args, 'ERROR', 'red'),
}

/**
 * 一个 HTTP 请求一行。由 `shared/middleware/requestLogger.js` 在响应结束时调用。
 *
 * 不打请求体：添加自备 Key 的接口 body 里就是明文密钥，日志必须绕开它。
 */
export function logRequest({ method, url, statusCode, durationMs, userId }) {
  if (isTest) return

  const status =
    statusCode >= 500
      ? paint('red', statusCode)
      : statusCode >= 400
        ? paint('yellow', statusCode)
        : paint('green', statusCode)

  const parts = [
    paint('gray', time()),
    method.padEnd(6),
    url,
    status,
    `${Math.round(durationMs)}ms`,
    userId ? paint('gray', `user=${userId}`) : '',
  ]

  process.stdout.write(`${parts.filter(Boolean).join(' ')}\n`)
}
