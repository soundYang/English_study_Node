import { randomBytes, timingSafeEqual } from 'node:crypto'

import { config } from '../../config/index.js'
import { adminAuthFailed, adminUserNotFound } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { maskPhone } from '../../shared/utils/mask.js'
import { escapeRegex } from '../../shared/utils/regex.js'
import { UserApiKey } from '../ai-keys/ai-key.model.js'
import { hashToken } from '../auth/auth.service.js'
import { getDummyHash, verifyPassword } from '../auth/password.js'
import { getProfileStats } from '../auth/profile.stats.js'
import { User } from '../auth/user.model.js'
import { getBudgetStatus } from '../budget/budget.service.js'
import { Feedback } from '../feedback/feedback.model.js'
import { recordLogin } from '../logs/log.service.js'
import { Quota } from '../quota/quota.model.js'
import { quotaDay } from '../quota/quota.service.js'
import { GenerationFailure } from '../readings/generation-failure.model.js'
import { measureKnownVocabulary } from '../readings/level-limits.js'
import { Reading } from '../readings/reading.model.js'
import { LEVELS } from '../readings/reading.schema.js'
import {
  emptyTokenBuckets,
  tokenBreakdownByUsers,
  tokenBreakdownForUser,
} from '../usage/token-usage.service.js'
import { TokenUsage } from '../usage/token-usage.model.js'
import { Word } from '../words/word.model.js'
import { wordRepository } from '../words/word.repository.js'
import { AdminSession } from './admin.model.js'

/**
 * 管理员后台的服务层（md/37）。
 *
 * 两块：单账号鉴权 + 只读的用户台账。台账的所有数字都必须来自
 * 「用户个人中心用的那套函数」，不能另写一遍——两套口径三个月后必然分叉，
 * 到时候管理员看到的数字和用户看到的对不上，谁也说不清哪个是真的。
 */

/** 12 小时。管理端是低频后台，没必要给 30 天 */
export const ADMIN_TOKEN_TTL_SECONDS = 12 * 60 * 60

/** 两项都配置了才挂载 `/api/admin/*`，否则整体 404（md/37 §2.1） */
export function isAdminConfigured() {
  return Boolean(config.adminUsername && config.adminPasswordHash)
}

/** 长度不同的字符串直接算不相等，避免 timingSafeEqual 抛错 */
function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))

  if (a.length !== b.length) return false

  return timingSafeEqual(a, b)
}

/**
 * 管理员登录。
 *
 * 用户名错时也要跑一次 scrypt（用陪跑哈希），否则响应时间会告诉爆破者
 * 「用户名对了，只是密码错」——用户侧登录早就这么做了，这里保持一致。
 */
export async function loginAdmin({ username = '', password = '', ip = '', userAgent = '' }) {
  if (!isAdminConfigured()) throw adminAuthFailed()

  const usernameOk = safeEqual(username, config.adminUsername)
  const hash = usernameOk ? config.adminPasswordHash : await getDummyHash()
  const passwordOk = await verifyPassword(password, hash)

  if (!usernameOk || !passwordOk) {
    logger.warn({ ip, username: String(username).slice(0, 32) }, 'admin login failed')
    // 失败也留痕：管理端是最值得盯的入口（md/53 §10）
    recordLogin({ username, role: 'admin', success: false, ip, userAgent })
    throw adminAuthFailed()
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + ADMIN_TOKEN_TTL_SECONDS * 1000)

  await AdminSession.create({
    username: config.adminUsername,
    tokenHash: hashToken(token),
    expiresAt,
    ip: String(ip ?? '').slice(0, 64),
    userAgent: String(userAgent ?? '').slice(0, 200),
  })

  logger.info({ admin: config.adminUsername, ip }, 'admin login')

  // userId 留空：管理员不是 users 表里的用户，用 role + username 识别
  recordLogin({ username: config.adminUsername, role: 'admin', success: true, ip, userAgent })

  return { token, expiresAt }
}

/** 解析令牌；无效一律返回 null（与用户侧同一原则：解析不抛错） */
export async function resolveAdminToken(token) {
  if (!token) return null

  return AdminSession.findOne({
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  }).lean()
}

export async function logoutAdmin(token) {
  if (token) await AdminSession.deleteOne({ tokenHash: hashToken(token) })
  return { ok: true }
}

export function toAdminDto(session) {
  return {
    username: session.username,
    expiresAt: session.expiresAt,
  }
}

// ——— 用户台账 ———

const DAY_MS = 24 * 60 * 60 * 1000

/** 北京时间今天的 0 点（与额度分桶同一个时区） */
function startOfToday(now = new Date()) {
  return new Date(Date.parse(`${quotaDay(now)}T00:00:00+08:00`))
}

/**
 * 管理端能看到的自备 Key 摘要（md/43 §7.4）。
 *
 * 只有「有没有 / 哪个厂商 / 能不能用 / 最近改过」——不含任何能还原或比对 Key
 * 的字段（cipher / last4 / fingerprint 一个都不取）。列表与详情共用这一个函数，
 * 两处字段名一旦分叉，前端就得写两套判断。
 */
function toApiKeySummary(doc) {
  if (!doc) return { hasKey: false }

  return {
    hasKey: true,
    provider: doc.provider,
    status: doc.status,
    updatedAt: doc.updatedAt,
  }
}

function buildUserFilter(q) {
  if (!q?.trim()) return {}

  const rx = new RegExp(escapeRegex(q.trim()), 'i')

  return { $or: [{ username: rx }, { nickname: rx }, { phone: rx }] }
}

function sortSpecFor(sort) {
  if (sort === 'lastLoginAt') return { lastLoginAt: -1, _id: -1 }
  if (sort === 'username') return { usernameLower: 1, _id: 1 }

  return { createdAt: -1, _id: -1 }
}

/**
 * 按 token / 文章数排序时先排 dataKey，再取那一页的用户。
 *
 * 这两项不是 users 文档上的字段，没法用 Mongo 的 sort 直接分页；
 * 全表聚合一次（几千用户，毫秒级）比给 users 加冗余计数字段更不容易出错。
 */
async function rankDataKeysBy(sort) {
  // 按 token 排序的口径必须与列表里显示的 tokens 一致（md/43 §7.2）：
  // 自备 Key 的调用不算平台成本，排序时也得排除，否则「排名第 1 但显示 0」
  const group = sort === 'tokens'
    ? [
        { $match: { keySource: { $ne: 'user' } } },
        { $group: { _id: '$userId', value: { $sum: '$totalTokens' } } },
      ]
    : [{ $group: { _id: '$userId', value: { $sum: 1 } } }]

  const model = sort === 'tokens' ? TokenUsage : Reading
  const rows = await model.aggregate([...group, { $sort: { value: -1 } }])

  return rows.map((row) => row._id)
}

/** 一页用户的基础指标；四组查询并发 */
async function attachMetrics(users, now = new Date()) {
  if (users.length === 0) return []

  const keys = users.map((user) => user.dataKey)
  const day = quotaDay(now)
  const today = startOfToday(now)

  const [wordRows, readingRows, tokenMap, quotaRows, failureRows, apiKeyRows] = await Promise.all([
    // 与 wordRepository.countVocabulary 同口径：只算 learning / mastered。
    // basic-removed 是 status=new 的占位行，天然被排除
    Word.aggregate([
      { $match: { userId: { $in: keys }, status: { $in: ['learning', 'mastered'] } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]),
    Reading.aggregate([
      { $match: { userId: { $in: keys } } },
      {
        $group: {
          _id: '$userId',
          generated: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
          // 分母用真实题数，与 profile.stats 同口径
          answered: {
            $sum: {
              $cond: [
                { $eq: ['$status', 'submitted'] },
                { $size: { $ifNull: ['$questions', []] } },
                0,
              ],
            },
          },
          correct: {
            $sum: {
              $cond: [
                { $eq: ['$status', 'submitted'] },
                { $ifNull: ['$correctCount', 0] },
                0,
              ],
            },
          },
          today: { $sum: { $cond: [{ $gte: ['$createdAt', today] }, 1, 0] } },
        },
      },
    ]),
    // 管理员台账只回答「平台为他花了多少」：自备 Key 的调用虽然也有流水，
    // 但花的是用户的钱，算进来会让平台成本虚高（md/43 §7.2）
    tokenBreakdownByUsers(keys, null, { includeUserKey: false }),
    Quota.find({ key: { $in: keys.map((key) => `acct:${key}`) }, day }).lean(),
    GenerationFailure.aggregate([
      { $match: { userId: { $in: keys } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]),
    // 自备 Key 的「有没有接入」必须在列表上就能看见：管理员判断一条反馈 / 一次
    // 报障时，先要知道这人走的是平台免费池还是自己的 Key（md/43 §7.4 只列了
    // 允许暴露的摘要字段，cipher / last4 / fingerprint 一律不取）
    UserApiKey.find({ userId: { $in: keys } })
      .select('userId provider status updatedAt')
      .lean(),
  ])

  const apiKeys = new Map(apiKeyRows.map((row) => [row.userId, row]))
  const words = new Map(wordRows.map((row) => [row._id, row.count]))
  const readings = new Map(readingRows.map((row) => [row._id, row]))
  const quotas = new Map(
    quotaRows.map((row) => [String(row.key).replace(/^acct:/, ''), row.used]),
  )
  const failures = new Map(failureRows.map((row) => [row._id, row.count]))

  return users.map((user) => {
    const stats = readings.get(user.dataKey) ?? {
      generated: 0,
      completed: 0,
      answered: 0,
      correct: 0,
      today: 0,
    }
    const accuracy =
      stats.answered > 0 ? Math.round((stats.correct / stats.answered) * 100) : 0
    // 开关关闭时库里没有记录，必须报 null 而不是 0/3（md/37 §3.6）
    const used = config.dailyQuotaEnabled ? (quotas.get(user.dataKey) ?? 0) : null

    return {
      dataKey: user.dataKey,
      username: user.username,
      nickname: user.nickname || user.username,
      phone: maskPhone(user.phone),
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? null,
      vocabulary: { personalWords: words.get(user.dataKey) ?? 0 },
      readings: {
        generated: stats.generated,
        completed: stats.completed,
        today: stats.today,
      },
      questions: { answered: stats.answered, correct: stats.correct, accuracy },
      tokens: tokenMap.get(user.dataKey) ?? emptyTokenBuckets(),
      failures: { count: failures.get(user.dataKey) ?? 0 },
      // 与详情接口同形：hasKey=false 时只给这一个字段，前端不必判 provider 是否存在
      apiKey: toApiKeySummary(apiKeys.get(user.dataKey)),
      quota: {
        enabled: config.dailyQuotaEnabled,
        limit: config.dailyQuotaEnabled ? config.dailyQuotaAccount : null,
        used,
        remaining: used === null ? null : Math.max(0, config.dailyQuotaAccount - used),
        day,
      },
    }
  })
}

/**
 * GET /api/admin/users
 *
 * 按 token / 文章数排序时走「先排名再取页」；其余排序交给 Mongo。
 */
export async function listUsers({ q = '', page = 1, size = 20, sort = 'createdAt', hasApiKey } = {}) {
  const clauses = [buildUserFilter(q)]

  // 「只看接了自备 Key 的人 / 只看没接的人」：UserApiKey 是独立集合，没有能直接
  // 塞进 users 查询的字段，先取一次 dataKey 集合。几千用户量级下是毫秒级；
  // 真到几十万再改成 $lookup 聚合，现在不值得为它牺牲可读性
  if (hasApiKey !== undefined) {
    const withKey = await UserApiKey.distinct('userId')
    clauses.push({ dataKey: hasApiKey ? { $in: withKey } : { $nin: withKey } })
  }

  const filter = clauses.length === 1 ? clauses[0] : { $and: clauses }
  const skip = (page - 1) * size

  if (sort === 'tokens' || sort === 'readings') {
    const matched = await User.find(filter).select('dataKey').lean()
    const allowed = new Set(matched.map((user) => user.dataKey))
    const ranked = (await rankDataKeysBy(sort)).filter((key) => allowed.has(key))

    // 没有任何记录的用户排在最后：只按 createdAt 补在队尾，不影响前几页
    if (ranked.length < allowed.size) {
      const rest = await User.find(
        { dataKey: { $in: [...allowed].filter((key) => !ranked.includes(key)) } },
      )
        .select('dataKey')
        .sort({ createdAt: -1 })
        .lean()

      ranked.push(...rest.map((user) => user.dataKey))
    }

    const pageKeys = ranked.slice(skip, skip + size)
    const users = await User.find({ dataKey: { $in: pageKeys } }).lean()
    const byKey = new Map(users.map((user) => [user.dataKey, user]))
    const ordered = pageKeys.map((key) => byKey.get(key)).filter(Boolean)

    return { total: ranked.length, page, size, items: await attachMetrics(ordered) }
  }

  const [users, total] = await Promise.all([
    User.find(filter).sort(sortSpecFor(sort)).skip(skip).limit(size).lean(),
    User.countDocuments(filter),
  ])

  return { total, page, size, items: await attachMetrics(users) }
}

/**
 * GET /api/admin/users/:dataKey
 *
 * 比列表多：全量手机号、三档 knownWords、最近 20 篇、失败 Top 3、
 * token 明细（成功 / 失败 / 取消 / 同步 / 历史）。
 */
export async function getUserDetail({ dataKey, now = new Date() }) {
  const user = await User.findOne({ dataKey }).lean()
  if (!user) throw adminUserNotFound()

  const [
    words,
    newWords,
    stats,
    quotaDoc,
    recent,
    failures,
    todayCount,
    failureTotal,
    apiKeyDoc,
  ] = await Promise.all([
    wordRepository.findVocabulary(dataKey),
    wordRepository.findNewWords(dataKey),
    getProfileStats({ userId: dataKey, now }),
    Quota.findOne({ key: `acct:${dataKey}`, day: quotaDay(now) }).lean(),
    Reading.find({ userId: dataKey })
      .sort({ createdAt: -1, _id: -1 })
      .limit(20)
      // 单篇的 aiMeta.totalTokens 只用于诊断，不参与用户总额（§12 第 4 条）
      .select('level targetWords actualWords status score correctCount questions aiMeta.totalTokens createdAt submittedAt')
      .lean(),
    GenerationFailure.aggregate([
      { $match: { userId: dataKey } },
      { $group: { _id: '$errorCode', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 3 },
    ]),
    Reading.countDocuments({ userId: dataKey, createdAt: { $gte: startOfToday(now) } }),
    GenerationFailure.countDocuments({ userId: dataKey }),
    // md/43 §7.4：只给摘要；cipher / last4 / fingerprint 任何管理接口都不返回
    UserApiKey.findOne({ userId: dataKey }).select('provider status updatedAt').lean(),
  ])

  const learnedWords = words.map((word) => word.word)
  const removedBasicWords = newWords.map((word) => word.word)

  const knownWords = {}
  for (const level of LEVELS) {
    knownWords[level] = measureKnownVocabulary({
      level,
      learnedWords,
      removedBasicWords,
    }).knownWords
  }

  // 同列表口径：详情里的 token 也只算平台出的钱（md/43 §7.2）
  const tokens = await tokenBreakdownForUser(dataKey, null, { includeUserKey: false })
  const used = config.dailyQuotaEnabled ? (quotaDoc?.used ?? 0) : null

  return {
    dataKey: user.dataKey,
    username: user.username,
    nickname: user.nickname || user.username,
    signature: user.signature ?? '',
    // 详情页给全量：客服要用它联系用户。访问行为进审计日志
    phone: user.phone ?? null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
    vocabulary: {
      personalWords: words.length,
      knownWords,
    },
    // 不用 stats.reading.totalTokens：那个口径是 aiMeta 求和，与 tokenusages
    // 是两套账，混着展示等于把「token 翻倍」的坑摆到管理员面前（§12 第 4 条）
    readings: {
      generated: stats.reading.generatedCount,
      completed: stats.reading.completedCount,
      today: todayCount,
      failed: failureTotal,
    },
    questions: stats.questions,
    tokens,
    apiKey: toApiKeySummary(apiKeyDoc),
    quota: {
      enabled: config.dailyQuotaEnabled,
      limit: config.dailyQuotaEnabled ? config.dailyQuotaAccount : null,
      used,
      remaining: used === null ? null : Math.max(0, config.dailyQuotaAccount - used),
      day: quotaDay(now),
      resetAt: new Date(
        Date.parse(`${quotaDay(now)}T00:00:00+08:00`) + DAY_MS,
      ),
    },
    recentReadings: recent.map((reading) => {
      const questionCount = Array.isArray(reading.questions) ? reading.questions.length : 0
      const correctCount = reading.correctCount ?? null
      const accuracy =
        reading.status === 'submitted' && questionCount > 0
          ? Math.round(((correctCount ?? 0) / questionCount) * 100)
          : null

      return {
        id: String(reading._id),
        level: reading.level,
        targetWords: reading.targetWords,
        actualWords: reading.actualWords,
        status: reading.status,
        score: reading.score ?? null,
        correctCount,
        questionCount,
        accuracy,
        tokens: reading.aiMeta?.totalTokens ?? 0,
        createdAt: reading.createdAt,
        submittedAt: reading.submittedAt ?? null,
      }
    }),
    failureSummary: {
      total: failures.reduce((sum, row) => sum + row.count, 0),
      topCodes: failures.map((row) => ({ code: row._id ?? 'UNKNOWN', count: row.count })),
    },
  }
}

/** GET /api/admin/overview */
export async function getOverview({ now = new Date() } = {}) {
  const today = startOfToday(now)

  const [
    totalUsers,
    activeToday,
    readingsToday,
    readingsTotal,
    feedbackRows,
    freeBudget,
    apiKeyRows,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ lastLoginAt: { $gte: today } }),
    Reading.countDocuments({ createdAt: { $gte: today } }),
    Reading.countDocuments({}),
    Feedback.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    getBudgetStatus(),
    // 自备 Key 的接入情况。invalid 不是「没接入」，是「接了但上游拒绝了」——
    // 单独列出来，管理员看到它涨就能联想到有一批人正在吃 403
    UserApiKey.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ])

  const feedback = { open: 0, replied: 0, closed: 0 }
  for (const row of feedbackRows) {
    if (row._id in feedback) feedback[row._id] = row.count
  }

  const apiKeys = { total: 0, active: 0, invalid: 0 }
  for (const row of apiKeyRows) {
    apiKeys.total += row.count
    if (row._id in apiKeys) apiKeys[row._id] = row.count
  }

  return {
    users: { total: totalUsers, activeToday },
    readings: { today: readingsToday, total: readingsTotal },
    tokens: { freeBudget },
    feedback,
    apiKeys,
  }
}
