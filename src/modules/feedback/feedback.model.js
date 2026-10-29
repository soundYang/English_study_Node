import mongoose from 'mongoose'

const { Schema } = mongoose

export const FEEDBACK_CATEGORIES = Object.freeze([
  'bug',
  'feature',
  'content',
  'data',
  'privacy',
  'other',
])

export const FEEDBACK_STATUSES = Object.freeze(['open', 'replied', 'closed'])

/**
 * 用户反馈（md/37 §4.2）。
 *
 * **不做软删除**：这是客服记录，删了就查不到「用户提过什么」。
 * 用户侧只能新增，状态只能由管理员推进（open → replied / closed）。
 *
 * `username` 是提交当时的**快照**：用户之后改名，反馈里仍然看得出是谁；
 * 未登录用户提交时为空，也能正常入库。
 *
 * **不存 `phone`**（md/45 §10.4）：手机号属于会变、且删号后必须一起消失的数据。
 * 管理端要显示时按 `userId` 关联 users 现查——用户换了号，反馈里跟着变；
 * 用户注销了，这里也不会残留一份联系方式的副本。
 */
const feedbackSchema = new Schema(
  {
    // dataKey；未登录提交时是 'anonymous'（见 feedback.service.js）
    userId: { type: String, required: true, index: true },
    username: { type: String, default: '' },

    category: { type: String, enum: FEEDBACK_CATEGORIES, required: true },
    content: { type: String, required: true, maxlength: 2000 },
    // 用户另外留下的联系方式，与账号手机号是两回事
    contact: { type: String, default: '', maxlength: 100 },
    // 提交页面，前端可传；不做枚举校验（前端路由会变）
    page: { type: String, default: '', maxlength: 100 },

    status: { type: String, enum: FEEDBACK_STATUSES, default: 'open' },
    reply: { type: String, default: '', maxlength: 2000 },
    repliedAt: { type: Date, default: null },
    // 当前恒为 admin；留字段是为了将来真的多管理员时不用迁移
    repliedBy: { type: String, default: '' },

    // 反滥用排查用；不展示给用户
    deviceId: { type: String, default: '' },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true },
)

feedbackSchema.index({ status: 1, createdAt: -1 })
feedbackSchema.index({ userId: 1, createdAt: -1 })
feedbackSchema.index({ category: 1, createdAt: -1 })
// 用户侧「5 次 / 天 / 设备」的计数依赖它
feedbackSchema.index({ deviceId: 1, createdAt: -1 })

export const Feedback = mongoose.model('Feedback', feedbackSchema)
