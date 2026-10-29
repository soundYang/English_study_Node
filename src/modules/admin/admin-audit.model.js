import mongoose from 'mongoose'

const { Schema } = mongoose

/** 审计日志保留天数（md/45 §10.1）；只追加，靠 TTL 自动清理 */
export const ADMIN_AUDIT_RETENTION_DAYS = 90

/**
 * 管理端审计日志（md/45 §10.1）。
 *
 * 之前「管理员看了谁的全量手机号」只打在 stdout 里，进程一重启就没了——
 * 出问题时既证明不了看过、也证明不了没看过。这张表就是那行日志的落库版本。
 *
 * 只记「谁、做了什么、对谁、从哪来」，**不记查到的内容本身**：
 * 审计表要是把手机号再抄一份，等于为了审计又开了一个泄露面。
 */
const adminAuditSchema = new Schema(
  {
    // 管理员用户名；与 AdminSession.username 同源，不是用户表的 _id
    admin: { type: String, default: '', maxlength: 100 },
    // 动作标识，如 user.detail / feedback.detail
    action: { type: String, required: true, maxlength: 60 },
    // 被操作对象的标识：用户的 dataKey、反馈的 _id 等
    target: { type: String, default: '', maxlength: 100 },
    ip: { type: String, default: '', maxlength: 64 },
    userAgent: { type: String, default: '', maxlength: 300 },
    // 与终端日志、错误响应同源，能把「管理员说没看过」和具体请求对上
    requestId: { type: String, default: '', maxlength: 40 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

adminAuditSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: ADMIN_AUDIT_RETENTION_DAYS * 24 * 60 * 60 },
)
adminAuditSchema.index({ admin: 1, createdAt: -1 })
adminAuditSchema.index({ target: 1, createdAt: -1 })

export const AdminAudit = mongoose.model('AdminAudit', adminAuditSchema)
