import mongoose from 'mongoose'

import { config } from '../../config/index.js'
import {
  badRequest,
  feedbackFlood,
  feedbackNotFound,
  feedbackTooLong,
  feedbackTooShort,
} from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { maskContact, maskPhone } from '../../shared/utils/mask.js'
import { User } from '../auth/user.model.js'
import { quotaDay } from '../quota/quota.service.js'
import { Feedback } from './feedback.model.js'

/**
 * 用户反馈（md/37 §5.1 / §5.2）。
 *
 * 写入只发生在这里，管理员只能改 `status / reply`；
 * 正文上任何编辑都是「改用户说过的话」，不在本期范围。
 */

export const FEEDBACK_MIN_LENGTH = 10
export const FEEDBACK_MAX_LENGTH = 2000
/** 一台设备一天最多提交几次；与登录限流分开，防的是刷库不是爆破 */
export const FEEDBACK_DAILY_LIMIT = 5
/**
 * 同一 IP 一天的上限（md/45 M3）。
 *
 * `X-Device-Id` 是客户端自报的，换一个值就是新桶，所以设备档挡不住脚本。
 * IP 档是唯一不依赖客户端自觉的兜底，定得比设备档宽（20 条 = 同一出口下
 * 最多 4 台设备各发满 5 条），共享出口（宿舍 / 公司）里的正常用户碰不到，
 * 脚本换设备 ID 也只能拿到 20 条。
 */
export const FEEDBACK_IP_DAILY_LIMIT = 20
/** 未登录提交的占位归属；管理端显示「未登录用户」 */
export const ANONYMOUS_DATA_KEY = 'anonymous'

/** 列表里只给摘要，正文里有用户的个人信息 */
export const FEEDBACK_EXCERPT_LENGTH = 80

function startOfQuotaDay(now = new Date()) {
  return new Date(Date.parse(`${quotaDay(now)}T00:00:00+08:00`))
}

function excerptOf(content) {
  const text = String(content ?? '')

  return text.length > FEEDBACK_EXCERPT_LENGTH
    ? `${text.slice(0, FEEDBACK_EXCERPT_LENGTH)}…`
    : text
}

/** 取用户快照；用户不存在（未登录 / 已删号）时返回空快照，不报错 */
async function snapshotOf(dataKey) {
  if (!dataKey || dataKey === ANONYMOUS_DATA_KEY) return { username: '' }

  const user = await User.findOne({ dataKey }).select('username').lean()

  return { username: user?.username ?? '' }
}

/**
 * 手机号不存快照，读的时候现查（md/45 §10.4）。
 *
 * 三件事因为这一处改动同时成立：用户换了号，管理端看到的是新号；
 * 用户注销后反馈里不残留联系方式；手机号在库里只有 `users` 一处。
 */
async function phoneOf(dataKey) {
  if (!dataKey || dataKey === ANONYMOUS_DATA_KEY) return null

  const user = await User.findOne({ dataKey }).select('phone').lean()

  return user?.phone ?? null
}

/** 列表用：一次查出这一页所有用户的手机号，避免 20 次单查 */
async function phoneMapOf(rows) {
  const keys = [
    ...new Set(
      rows
        .map((row) => row.userId)
        .filter((key) => key && key !== ANONYMOUS_DATA_KEY),
    ),
  ]

  if (keys.length === 0) return new Map()

  const users = await User.find({ dataKey: { $in: keys } }).select('dataKey phone').lean()

  return new Map(users.map((user) => [user.dataKey, user.phone ?? null]))
}

/**
 * 提交反馈。
 *
 * 未登录也能提交（客服很需要这种渠道），此时 `userId` 落成 `anonymous`。
 * 计数按设备 + 北京时间当天；同一设备说清一个问题通常一条就够，
 * 5 条还说不完的，多给渠道只会变成刷屏。
 */
export async function createFeedback({
  userId,
  body = {},
  deviceId = '',
  ip = '',
  userAgent = '',
  now = new Date(),
}) {
  const content = String(body.content ?? '').trim()

  if (content.length < FEEDBACK_MIN_LENGTH) throw feedbackTooShort(FEEDBACK_MIN_LENGTH)
  if (content.length > FEEDBACK_MAX_LENGTH) throw feedbackTooLong(FEEDBACK_MAX_LENGTH)

  // 设备与 IP 两个桶**同时判**，任一到顶就拒（md/45 M3）。
  //
  // 不能只按设备：`X-Device-Id` 是客户端自报的，换一个值就是新桶；
  // 也不能只按 IP：同一个 NAT 后面多台设备会被并成一个桶，一台刷完
  // 整个办公室就发不了反馈。所以设备档负责区分度（5/天），IP 档负责兜底（20/天）。
  // 没有设备 ID 时只剩 IP 档——匿名提交不允许完全无法归因。
  const since = startOfQuotaDay(now)
  const buckets = [
    deviceId && { key: { deviceId }, limit: FEEDBACK_DAILY_LIMIT },
    ip && { key: { ip }, limit: FEEDBACK_IP_DAILY_LIMIT },
  ].filter(Boolean)

  if (buckets.length > 0) {
    const used = await Promise.all(
      buckets.map((bucket) =>
        Feedback.countDocuments({ ...bucket.key, createdAt: { $gte: since } }),
      ),
    )

    const hit = buckets.find((bucket, index) => used[index] >= bucket.limit)
    if (hit) throw feedbackFlood(hit.limit)
  }

  const dataKey = userId || ANONYMOUS_DATA_KEY
  const snapshot = await snapshotOf(dataKey)

  const feedback = await Feedback.create({
    userId: dataKey,
    username: snapshot.username,
    category: body.category,
    content,
    contact: String(body.contact ?? '').trim(),
    page: String(body.page ?? '').trim(),
    status: 'open',
    deviceId: String(deviceId ?? '').slice(0, 64),
    ip: String(ip ?? '').slice(0, 64),
    userAgent: String(userAgent ?? '').slice(0, 200),
  })

  // 正文绝不进日志：只记长度与分类（§6）
  logger.info(
    { feedbackId: String(feedback._id), category: feedback.category, length: content.length },
    'feedback submitted',
  )

  return {
    id: String(feedback._id),
    status: feedback.status,
    createdAt: feedback.createdAt,
  }
}

// ——— 管理端 ———

/**
 * 列表与详情的公共字段。
 *
 * `reveal` 默认 false：**列表一律打码**（md/45 M6）。完整手机号与联系方式
 * 只在详情里给，详情有管理端审计点；列表没有——一次翻页 20 条，管理员账号
 * 被借用就能批量导出，而且查不到痕迹。
 *
 * `phone` 由调用方传入（现查 users），文档里没有这个字段（md/45 §10.4）。
 */
function toListItem(doc, { reveal = false, phone = null } = {}) {
  return {
    id: String(doc._id),
    userId: doc.userId,
    username: doc.username || (doc.userId === ANONYMOUS_DATA_KEY ? '未登录用户' : ''),
    phone: reveal ? (phone ?? null) : maskPhone(phone),
    category: doc.category,
    excerpt: excerptOf(doc.content),
    status: doc.status,
    contact: reveal ? (doc.contact ?? '') : maskContact(doc.contact),
    page: doc.page,
    repliedAt: doc.repliedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function toDetail(doc, phone = null) {
  return {
    // 详情给完整值：客服要打电话 / 加微信，打码等于把这条路堵死
    ...toListItem(doc, { reveal: true, phone }),
    content: doc.content,
    reply: doc.reply,
    repliedBy: doc.repliedBy,
    // 排查用；管理员看一眼就知道是不是同一台设备刷的
    deviceId: doc.deviceId,
    ip: doc.ip,
    userAgent: doc.userAgent,
  }
}

export async function listFeedback({ status, category, page = 1, size = 20 } = {}) {
  const filter = {}
  if (status) filter.status = status
  if (category) filter.category = category

  const [rows, total] = await Promise.all([
    Feedback.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * size)
      .limit(size)
      // 不取 content 全文：列表可能很长，正文里有用户个人信息
      .select('userId username category status contact page repliedAt createdAt updatedAt content')
      .lean(),
    Feedback.countDocuments(filter),
  ])

  const phones = await phoneMapOf(rows)

  return {
    total,
    page,
    size,
    items: rows.map((row) => toListItem(row, { phone: phones.get(row.userId) ?? null })),
  }
}

export async function getFeedbackDetail(id) {
  if (!mongoose.isValidObjectId(id)) throw feedbackNotFound()

  const doc = await Feedback.findById(id).lean()
  if (!doc) throw feedbackNotFound()

  return toDetail(doc, await phoneOf(doc.userId))
}

/**
 * 回复 / 关闭。
 *
 * `status` 只允许 `replied` / `closed`——`open` 是用户提交时的初始态，
 * 管理员不能把已回复的反馈「退回未处理」，那等于抹掉回复记录。
 * 已关闭的可以再回复，回到 `replied`（客服补一句是常态）。
 */
export async function updateFeedback({ id, status, reply, admin = '' }) {
  if (!mongoose.isValidObjectId(id)) throw feedbackNotFound()

  const doc = await Feedback.findById(id)
  if (!doc) throw feedbackNotFound()

  if (status) doc.status = status

  if (status === 'replied' || reply !== undefined) {
    const text = String(reply ?? '').trim()

    // zod 已经拦过一次；这里是不变量，避免别处直接调 service 写进空回复
    if (status === 'replied' && !text) {
      throw badRequest('标记为已回复时必须填写回复内容', 'reply')
    }

    if (text) {
      doc.reply = text
      doc.repliedAt = new Date()
      doc.repliedBy = admin || config.adminUsername
    }
  }

  await doc.save()

  logger.info(
    { admin: admin || config.adminUsername, action: 'feedback.update', target: String(doc._id), status: doc.status },
    'admin action',
  )

  return toDetail(doc.toObject(), await phoneOf(doc.userId))
}
