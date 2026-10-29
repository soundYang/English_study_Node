import mongoose from 'mongoose'

import { config } from '../../config/index.js'

const { Schema } = mongoose

/**
 * 登录记录（md/53 §10）：一次登录 / 注册尝试一条，**成功与失败都记**。
 *
 * 为什么不从 accesslogs 里反推：
 *   · 登录请求进入时还没有令牌，`req.userId` 是空的，访问日志无法归属到用户；
 *   · 用户会话（`sessions`）只存 UA，不存 IP；管理员会话虽然有 IP，但随登出 / 过期就删了。
 *
 * 所以「谁在什么 IP 登录过」需要独立的一张表。写入口在登录服务里（那里才知道
 * 是哪个用户），与 accesslogs 的分工：
 *   · accesslogs    —— 所有请求的流水，回答「这个 IP 浏览了什么」；
 *   · loginrecords  —— 只回答「登录」，失败尝试也留痕（安全排查）。
 *
 * 不存密码、令牌、验证码；`username` 失败时是用户输入的值（截断后），
 * 用于识别爆破目标。
 */
const loginRecordSchema = new Schema(
  {
    // dataKey；失败（用户不存在 / 密码错）时为空
    userId: { type: String, default: '', maxlength: 100 },
    username: { type: String, default: '', maxlength: 100 },
    role: { type: String, enum: ['user', 'admin'], required: true },
    success: { type: Boolean, required: true },
    ip: { type: String, default: '', maxlength: 64 },
    userAgent: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

// 保留期比访问日志长：登录事件很少，而「半年前谁从哪登录过」恰恰是安全排查要看的东西
loginRecordSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: Math.max(1, config.loginLogRetentionDays) * 24 * 60 * 60 },
)
loginRecordSchema.index({ createdAt: -1 })
loginRecordSchema.index({ userId: 1, createdAt: -1 })
loginRecordSchema.index({ ip: 1, createdAt: -1 })
loginRecordSchema.index({ success: 1, createdAt: -1 })

export const LoginRecord = mongoose.model('LoginRecord', loginRecordSchema)
