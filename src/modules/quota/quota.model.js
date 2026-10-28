import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 每日生成额度（md/35 §5.1）。
 *
 * 一行 = 一个身份键在某个北京时间自然日已经用掉几次。
 *
 * 为什么不把计数写在 users 上：
 *   · 匿名用户没有 users 文档，但也必须限次数；
 *   · 跨天重置要么靠定时任务（会漏），要么靠读的时候判断（并发下要额外锁）。
 * 独立集合 + `{ key, day }` 唯一索引，重置就是「换一个 day」——
 * 新的一天天然从 0 开始，旧文档交给 TTL 自己消失。
 */
const quotaSchema = new Schema(
  {
    // 'acct:<dataKey>' | 'dev:<deviceId>' | 'net:<sha256 前 32 位>'
    key: { type: String, required: true },
    // 北京时间日期，'YYYY-MM-DD'。用字符串而不是 Date：
    // 分桶键直接可读，也不受服务器时区与 Mongoose 日期序列化影响
    day: { type: String, required: true },
    used: { type: Number, required: true, default: 0, min: 0 },
    // 当天结束 + 30 天。留一个月足够排查「昨天为什么被锁」，之后自动清理
    expireAt: { type: Date, required: true },
  },
  { versionKey: false },
)

// 预扣的原子性全靠这个唯一索引：upsert 撞车时靠 E11000 重试（见 quota.service.js）
quotaSchema.index({ key: 1, day: 1 }, { unique: true })
// TTL：过期日桶自己消失，不需要任何定时任务
quotaSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 })

export const Quota = mongoose.model('Quota', quotaSchema)
