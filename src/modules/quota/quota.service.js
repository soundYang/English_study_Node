import { createHash } from 'node:crypto'

import { config } from '../../config/index.js'
import { quotaExceeded } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { Quota } from './quota.model.js'

/**
 * 每日额度（md/35）。
 *
 * 三件事：
 *   1. 算出「这次请求是谁在花钱」——账号、设备、网络指纹三把锁；
 *   2. 原子预扣 / 退还；
 *   3. 给前端一份当前剩余（GET /api/quota）。
 *
 * 这里**不认识**生成任务：任务侧要退款时，先用任务仓库的条件更新抢到
 * `quota.refundedAt`，再调 `releaseQuota()`。额度模块只负责加减计数。
 */

/** 额度按北京时间自然日重置。写死而不是做成配置：容器跑 UTC、开发机跑东八区，结果必须一致 */
export const QUOTA_TIMEZONE = 'Asia/Shanghai'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * en-CA 的短日期格式就是 YYYY-MM-DD，正好当分桶键。
 * 不用 `toISOString().slice(0, 10)`：那是 UTC 日期，北京早上 8 点前会算成前一天。
 */
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: QUOTA_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** @returns {string} 北京时间日期，如 '2026-10-29' */
export function quotaDay(now = new Date()) {
  return dayFormatter.format(now)
}

/**
 * 北京时间次日 0 点。
 *
 * 东八区固定 UTC+8、没有夏令时，所以直接平移 8 小时再取「次日 UTC 0 点」即可，
 * 不依赖运行环境的 TZ（测试会在 UTC 下跑）。
 */
export function nextResetAt(now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 3600_000)
  const nextMidnightUtc = Date.UTC(
    shanghai.getUTCFullYear(),
    shanghai.getUTCMonth(),
    shanghai.getUTCDate() + 1,
  )

  return new Date(nextMidnightUtc - 8 * 3600_000)
}

/** 日桶的过期时间：当天结束 + 30 天（md/35 §5.1） */
export function quotaExpireAt(day) {
  return new Date(Date.parse(`${day}T00:00:00+08:00`) + 31 * DAY_MS)
}

/**
 * 设备 ID 的合法形状：16–64 位 `[A-Za-z0-9_-]`。
 * UUID v4、base64url 都符合；太短的值（'1'、'abc'）等于没有区分度，直接忽略。
 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

/**
 * 读 `X-Device-Id`。
 *
 * 非法值**不报 400**：一个坏 header 不该让生成失败，当作没传即可。
 * 它只影响额度口径（退化成只按网络指纹），不参与任何身份判断。
 */
export function readDeviceId(header) {
  if (typeof header !== 'string') return ''
  const value = header.trim()

  return DEVICE_ID_PATTERN.test(value) ? value : ''
}

/**
 * 网络指纹：只取浏览器会稳定发送、且不需要前端配合的字段。
 *
 * 只存哈希，不存 IP / UA 原文。UA 大版本升级会变，所以它只做兜底（10 次/天），
 * 不承担主额度（md/35 §3.4）。
 */
export function networkFingerprint({ ip, userAgent, acceptLanguage, secChUa, secChUaPlatform }) {
  const raw = [
    ip ?? '',
    userAgent ?? '',
    acceptLanguage ?? '',
    secChUa ?? '',
    secChUaPlatform ?? '',
  ].join('|')

  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * 本次请求要检查的额度键，顺序即展示优先级（账号 → 设备 → 网络）。
 *
 * **账号键只能取 `req.auth.user.dataKey`**：`AUTH_ENFORCED=false` 时
 * `req.userId` 会回落成 local-user，拿它当账号键会让所有匿名用户共用一个桶，
 * 还会把第一个注册用户的额度吃光（md/35 §3.2）。
 */
export function quotaKeysFor(identity = {}) {
  const keys = []
  const dataKey = identity.user?.dataKey

  if (dataKey) {
    keys.push({ key: `acct:${dataKey}`, scope: 'account', limit: config.dailyQuotaAccount })
  }

  if (identity.deviceId) {
    keys.push({ key: `dev:${identity.deviceId}`, scope: 'device', limit: config.dailyQuotaDevice })
  }

  keys.push({
    key: `net:${networkFingerprint(identity)}`,
    scope: 'network',
    limit: config.dailyQuotaNetwork,
  })

  return keys
}

/** 把 Express 的 req 转成额度需要的身份；只读，不修改 req */
export function quotaIdentityFromRequest(req) {
  return {
    // 真登录才有账号键；req.userId 的回落值不参与（见 quotaKeysFor 注释）
    user: req.auth?.user ?? null,
    deviceId: readDeviceId(req.get('X-Device-Id')),
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    acceptLanguage: req.get('Accept-Language'),
    secChUa: req.get('Sec-CH-UA'),
    secChUaPlatform: req.get('Sec-CH-UA-Platform'),
  }
}

/**
 * 单键预扣一次。
 *
 * 必须是「过滤条件 + 自增」同一个原子更新：先查再改的话，两个并发请求
 * 都读到 used=2，都写 3，实际放进来 4 次。
 *
 * upsert 的坑：文档已存在且 used 已满时，条件不匹配 → Mongo 尝试插入 →
 * 撞 `{ key, day }` 唯一索引 → E11000。这不是错误，只是「满了」的另一种写法，
 * 所以 catch 后改用不带 upsert 的条件更新再确认一次。
 */
async function consumeOne({ key, day, limit }) {
  try {
    const doc = await Quota.findOneAndUpdate(
      { key, day, used: { $lt: limit } },
      { $inc: { used: 1 }, $setOnInsert: { expireAt: quotaExpireAt(day) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )

    return doc ? { ok: true, used: doc.used } : { ok: false, used: limit }
  } catch (error) {
    if (error?.code !== 11000) throw error
  }

  const doc = await Quota.findOneAndUpdate(
    { key, day, used: { $lt: limit } },
    { $inc: { used: 1 } },
    { new: true },
  )

  return doc ? { ok: true, used: doc.used } : { ok: false, used: limit }
}

/**
 * 退还若干个键（每个 -1）。
 *
 * `used: { $gt: 0 }` 兜底，永远不会减成负数。失败只记日志：
 * 退还失败最多让用户少一次额度，不能让退款异常覆盖原本要给用户的错误。
 */
export async function releaseQuota({ keys, day }) {
  if (!Array.isArray(keys) || keys.length === 0 || !day) return

  await Promise.all(
    keys.map((key) =>
      Quota.updateOne({ key, day, used: { $gt: 0 } }, { $inc: { used: -1 } }).catch((error) => {
        // 键里有设备 ID / dataKey，日志只落哈希（md/35 §3.3）
        logger.warn({ err: error, keyHash: maskKey(key), day }, 'quota release failed')
      }),
    ),
  )
}

/** 日志用：不落原始键，只留前 12 位哈希，够人对上同一设备又不泄露原值 */
function maskKey(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12)
}

/**
 * 预扣：账号 / 设备 / 网络三个键依次 +1，任意一个满了就整体失败。
 *
 * 失败时把前面已经加过的键还回去——否则「账号有额度、设备满了」的请求
 * 会白白吃掉账号的一次（md/35 §6.2）。
 *
 * @returns {Promise<{ day: string, keys: string[] } | null>} 开关关闭时返回 null
 */
export async function reserveQuota({ identity, now = new Date() }) {
  if (!config.dailyQuotaEnabled) return null

  const day = quotaDay(now)
  const keys = quotaKeysFor(identity)
  const reserved = []

  try {
    for (const item of keys) {
      const result = await consumeOne({ key: item.key, day, limit: item.limit })

      if (!result.ok) {
        throw quotaExceeded({
          scope: item.scope,
          limit: item.limit,
          used: result.used,
          resetAt: nextResetAt(now),
        })
      }

      reserved.push(item.key)
    }

    return { day, keys: reserved }
  } catch (error) {
    await releaseQuota({ keys: reserved, day })
    throw error
  }
}

/** 同步生成等「没有任务文档可挂」的场景用它退还 */
export async function releaseReservation(reservation) {
  if (!reservation) return
  await releaseQuota({ keys: reservation.keys, day: reservation.day })
}

/**
 * GET /api/quota 的数据（md/35 §7.1）。
 *
 * primary  = 界面展示项（登录看账号，否则看设备，再否则网络）；
 * blocking = 任意一个键已经用尽时给那一项——primary 还有余量但网络满了，
 *            前端也必须禁用生成按钮。
 */
export async function getQuotaSnapshot({ identity, now = new Date() }) {
  const day = quotaDay(now)
  const keys = quotaKeysFor(identity)

  const docs = config.dailyQuotaEnabled
    ? await Quota.find({ day, key: { $in: keys.map((item) => item.key) } }).lean()
    : []

  const usedByKey = new Map(docs.map((doc) => [doc.key, doc.used]))

  const breakdown = keys.map((item) => {
    const used = usedByKey.get(item.key) ?? 0

    return {
      scope: item.scope,
      limit: item.limit,
      used,
      remaining: Math.max(0, item.limit - used),
    }
  })

  return {
    day,
    resetAt: nextResetAt(now).toISOString(),
    // 顺序由 quotaKeysFor 保证：账号 → 设备 → 网络
    primary: breakdown[0],
    blocking: breakdown.find((item) => item.remaining === 0) ?? null,
    breakdown,
  }
}
