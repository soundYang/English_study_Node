import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { config } from '../../config/index.js'
import {
  captchaRequired,
  invalidCredentials,
  phoneTaken,
  usernameTaken,
} from '../../shared/errors.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { recordLogin } from '../logs/log.service.js'
import { AppMeta } from './appmeta.model.js'
import { loginSchema, registerSchema } from './auth.schema.js'
import { verifyCaptcha } from './captcha.service.js'
import { getDummyHash, hashPassword, needsRehash, verifyPassword } from './password.js'
import { Session } from './session.model.js'
import { User } from './user.model.js'

/**
 * 注册 / 登录 / 会话（md/33 §4、§6、§8）。
 *
 * 三个概念必须分清，混在一起就会写出「以为改了密码但旧设备还能用」这种 bug：
 *   身份   users._id
 *   数据   users.dataKey —— 所有业务集合里的 userId
 *   凭证   sessions 里的一条记录，客户端手里是令牌原文
 */

/** 不勾「记住账号」1 天，勾了 30 天（md/33 §4.3） */
export const SESSION_TTL_SECONDS = Object.freeze({
  standard: 24 * 60 * 60,
  remember: 30 * 24 * 60 * 60,
})

/** 单用户最多 10 个有效会话，超出踢掉最旧的 */
const MAX_SESSIONS_PER_USER = 10

/** 第一个注册的用户接管这个数据域（md/33 §8） */
export const LEGACY_DATA_KEY = 'local-user'
const LEGACY_META_ID = 'legacy-owner'

/** 登录失败达到这个次数后，后续登录必须带图形验证码 */
const LOGIN_FAILURE_LIMIT = 5
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * 令牌原文只存在于客户端，库里存它的 sha256。
 *
 * 这里用快哈希而不是 scrypt：令牌是 256 位随机数，没有「口令空间」可以被穷举，
 * 慢哈希只会让每个请求多花 80 ms。
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** 对外暴露的用户字段。**不返回** dataKey / passwordHash / usernameLower */
export function toUserDto(user) {
  return {
    id: String(user._id),
    username: user.username,
    nickname: user.nickname || user.username,
    signature: user.signature ?? '',
    phone: user.phone ?? null,
    createdAt: user.createdAt,
  }
}

// ——— 登录失败计数 ———
// 进程内 Map。多实例部署时不共享，代价只是「在 A 上失败 5 次、到 B 上还能再试 5 次」，
// 不影响正确性（真正的兜底是登录接口按 IP 的限流）。
const loginFailures = new Map()

function recordLoginFailure(identifier) {
  const now = Date.now()
  const entry = loginFailures.get(identifier)

  if (!entry || now - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.set(identifier, { count: 1, firstAt: now })
    // 长期没人登录的 key 不会自己消失，攒到一定量就顺手清一遍
    if (loginFailures.size > 5000) {
      for (const [key, value] of loginFailures) {
        if (now - value.firstAt > LOGIN_FAILURE_WINDOW_MS) loginFailures.delete(key)
      }
    }
    return
  }

  entry.count += 1
}

function requiresCaptcha(identifier) {
  const entry = loginFailures.get(identifier)
  if (!entry) return false

  if (Date.now() - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(identifier)
    return false
  }

  return entry.count >= LOGIN_FAILURE_LIMIT
}

function clearLoginFailures(identifier) {
  loginFailures.delete(identifier)
}

/** 只给测试用：失败计数是进程内状态，用例之间必须能清干净 */
export function resetLoginFailures() {
  loginFailures.clear()
}

/** 唯一索引撞了之后，把「哪个字段重复」翻译成业务错误；其它错误原样抛 */
function mapDuplicateKeyError(err) {
  if (err?.code !== 11000) return null

  const key = Object.keys(err.keyPattern ?? {})[0] ?? ''
  if (key === 'phone') return phoneTaken()
  if (key === 'usernameLower') return usernameTaken()

  return null
}

/**
 * 这个用户名是否被允许接管 legacy 数据（md/45 M1）。
 *
 * `allowed` 参数只为测试：生产永远读配置里的白名单。
 */
export function mayClaimLegacyDataKey(username, allowed = config.legacyClaimUsers) {
  const name = String(username ?? '').trim().toLowerCase()

  return name !== '' && allowed.includes(name)
}

/**
 * 让**白名单内**的用户接管 `local-user` 的历史数据。
 *
 * 修复前是「谁先注册谁拿」——先注册的未必是站主，一次抢跑就把全部历史数据
 * 交给陌生人。现在按身份授权：`LEGACY_CLAIM_USER` 没配就谁都不接管，
 * 历史数据留在原处等人工迁移。
 *
 * 必须**在用户建好之后**再抢：反过来的话，一次「用户名已被占用」的注册
 * 也会把这个名额消耗掉，真正的白名单用户反而拿不到数据。
 * 用户此时还没有任何业务数据，改 dataKey 是安全的。
 */
async function claimLegacyDataKey(user) {
  if (!mayClaimLegacyDataKey(user.username)) return

  try {
    await AppMeta.create({ _id: LEGACY_META_ID, claimedBy: user._id, claimedAt: new Date() })
  } catch (err) {
    // 已经有人接管过了
    if (err?.code === 11000) return
    throw err
  }

  user.dataKey = LEGACY_DATA_KEY
  await User.updateOne({ _id: user._id }, { $set: { dataKey: LEGACY_DATA_KEY } })
}

async function trimSessions(userId) {
  const stale = await Session.find({ userId })
    .sort({ createdAt: -1 })
    .skip(MAX_SESSIONS_PER_USER)
    .select('_id')

  if (stale.length > 0) {
    await Session.deleteMany({ _id: { $in: stale.map((doc) => doc._id) } })
  }
}

async function issueSession({ user, rememberMe, userAgent }) {
  const token = `sess_${randomBytes(32).toString('base64url')}`
  const ttlSeconds = rememberMe ? SESSION_TTL_SECONDS.remember : SESSION_TTL_SECONDS.standard
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

  await Session.create({
    userId: user._id,
    tokenHash: hashToken(token),
    expiresAt,
    ttlSeconds,
    userAgent: String(userAgent ?? '').slice(0, 200),
  })

  await trimSessions(user._id)

  return { token, expiresAt }
}

/**
 * 注册。成功后直接登录（返回令牌），省掉「注册完再登一次」。
 *
 * @param {{ body: object, ip?: string, userAgent?: string }} payload
 */
export async function registerUser({ body, ip = '', userAgent = '' }) {
  const input = parseOrThrow(registerSchema, body)

  // 先消耗验证码再查重：否则「这个用户名被占了吗」不用解题就能问出来
  await verifyCaptcha({ captchaId: input.captchaId, answer: input.captchaCode })

  const passwordHash = await hashPassword(input.password)

  let user
  try {
    user = await User.create({
      username: input.username,
      usernameLower: input.username.toLowerCase(),
      passwordHash,
      phone: input.phone ?? null,
      // 昵称默认跟用户名一致；之后可以在个人中心改
      nickname: input.username,
      // 先给一个临时数据域，抢到 legacy 名额再改（见 claimLegacyDataKey）
      dataKey: `u_${randomUUID()}`,
      lastLoginAt: new Date(),
    })
  } catch (err) {
    const mapped = mapDuplicateKeyError(err)
    if (mapped) throw mapped
    throw err
  }

  await claimLegacyDataKey(user)

  const session = await issueSession({ user, rememberMe: false, userAgent })

  // 注册即登录，同样算一次登录（md/53 §10）
  recordLogin({
    userId: user.dataKey,
    username: user.username,
    role: 'user',
    success: true,
    ip,
    userAgent,
  })

  return { ...session, user: toUserDto(user) }
}

/**
 * 登录。
 *
 * 用户不存在时**也要跑一次 scrypt**（用 dummy hash 陪跑）：
 * 直接返回的话，「不存在」比「密码错」快几十毫秒，这个时间差足够枚举账号。
 */
export async function loginUser({ body, ip = '', userAgent = '' }) {
  const input = parseOrThrow(loginSchema, body)
  const identifier = input.usernameOrPhone.toLowerCase()

  if (requiresCaptcha(identifier)) {
    if (!input.captchaId || !input.captchaCode) throw captchaRequired()
    await verifyCaptcha({ captchaId: input.captchaId, answer: input.captchaCode })
  }

  const user = await User.findOne({
    $or: [{ usernameLower: identifier }, { phone: input.usernameOrPhone }],
  })

  if (!user) {
    await verifyPassword(input.password, await getDummyHash())
    recordLoginFailure(identifier)
    recordLogin({
      username: input.usernameOrPhone,
      role: 'user',
      success: false,
      ip,
      userAgent,
    })
    throw invalidCredentials()
  }

  const passed = await verifyPassword(input.password, user.passwordHash)
  if (!passed) {
    recordLoginFailure(identifier)
    recordLogin({
      userId: user.dataKey,
      username: user.username,
      role: 'user',
      success: false,
      ip,
      userAgent,
    })
    throw invalidCredentials()
  }

  clearLoginFailures(identifier)

  // 参数升级：登录是唯一能拿到明文密码的时刻（md/33 §4.1）
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(input.password)
    await User.updateOne({ _id: user._id }, { $set: { passwordHash: upgraded } })
  }

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })

  const session = await issueSession({ user, rememberMe: input.rememberMe === true, userAgent })

  recordLogin({
    userId: user.dataKey,
    username: user.username,
    role: 'user',
    success: true,
    ip,
    userAgent,
  })

  return { ...session, user: toUserDto(user) }
}

/** 退出：只删当前这一条。令牌无效时也是成功（幂等） */
export async function logoutUser({ token }) {
  if (token) await Session.deleteOne({ tokenHash: hashToken(token) })
  return { ok: true }
}

/**
 * 把请求里的令牌解析成 `{ user, session }`；无效一律返回 null，**不抛**。
 *
 * 不抛的原因：解析是每个请求都要做的，健康检查、验证码这些公开接口也在其中，
 * 让无效令牌变成异常会把它们一起拖成 500。拦不拦由 requireAuth 决定。
 */
export async function resolveSession(token) {
  if (!token) return null

  // expiresAt 必须在查询里判：TTL 是后台线程清的，过期文档可能还躺在库里
  const session = await Session.findOne({
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  })
  if (!session) return null

  const user = await User.findById(session.userId)
  if (!user) {
    // 用户被删了，令牌没有意义了，顺手清掉
    await Session.deleteOne({ _id: session._id })
    return null
  }

  await touchSession(session)

  return { user, session }
}

/**
 * 滑动续期 + 更新最后活跃时间。
 *
 * 两个阈值都刻意保守：
 *   · 只有「剩余不足一半」才续，避免每个请求一次写库（生成页 1 秒一轮询）；
 *   · lastSeenAt 每分钟最多写一次，否则读接口会被这条写拖慢。
 */
async function touchSession(session) {
  const now = Date.now()
  const ttlMs = (session.ttlSeconds || SESSION_TTL_SECONDS.standard) * 1000
  const update = {}

  if (session.expiresAt.getTime() - now < ttlMs / 2) {
    update.expiresAt = new Date(now + ttlMs)
  }
  if (now - session.lastSeenAt.getTime() > 60_000) {
    update.lastSeenAt = new Date(now)
  }

  if (Object.keys(update).length > 0) {
    await Session.updateOne({ _id: session._id }, { $set: update })
  }
}
