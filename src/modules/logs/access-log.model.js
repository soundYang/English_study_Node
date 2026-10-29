import mongoose from 'mongoose'

import { config } from '../../config/index.js'

const { Schema } = mongoose

/**
 * 访问日志（md/53）：一次 HTTP 请求一条，含来源 IP。
 *
 * 终端日志只活在运行窗口里，重启就没了；这张表回答的是「谁在什么时候
 * 从哪个 IP 访问了哪个接口」，用于排查异常流量和用户反馈时定位。
 *
 * 明确不存的东西：
 *   · 请求体 / 响应体 —— 自备 Key 接口的 body 是明文密钥；
 *   · Authorization / Cookie 等请求头 —— 令牌等同于账号；
 *   · 设备指纹原文 —— 额度用的是哈希，这里也不重复存。
 *
 * 数据量按请求线性增长，靠 TTL 索引自动清理（默认 30 天，md/53 §4）。
 */
const accessLogSchema = new Schema(
  {
    method: { type: String, required: true, maxlength: 10 },
    // 只存路径，**不带 query**（md/45 §10.3）：query 里可能有搜索词、手机号，
    // 甚至是别人贴进链接里的令牌，而能查这张表的人不应该顺带看到这些
    path: { type: String, required: true, maxlength: 400 },
    statusCode: { type: Number, required: true },
    durationMs: { type: Number, default: 0 },
    // req.ip：反代后面必须配置 TRUST_PROXY，否则这里是反代地址（md/35 §3.4）
    ip: { type: String, default: '', maxlength: 64 },
    userId: { type: String, default: '', maxlength: 100 },
    userAgent: { type: String, default: '', maxlength: 300 },
    // 浏览器来源。局域网联调时能直接看出请求是不是自己那台机器发的
    origin: { type: String, default: '', maxlength: 200 },
    // 与错误响应里的 requestId 同源，用户报错时靠它把两边的日志对上
    requestId: { type: String, default: '', maxlength: 40 },
  },
  { timestamps: true },
)

// 过期清理：只保留最近 N 天，避免这张只追加的表无限增长
accessLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: Math.max(1, config.accessLogRetentionDays) * 24 * 60 * 60 },
)
// 列表默认按时间倒序
accessLogSchema.index({ createdAt: -1 })
// 排查「某个 IP 干了什么」「某个用户访问了哪些接口」
accessLogSchema.index({ ip: 1, createdAt: -1 })
accessLogSchema.index({ userId: 1, createdAt: -1 })

export const AccessLog = mongoose.model('AccessLog', accessLogSchema)
