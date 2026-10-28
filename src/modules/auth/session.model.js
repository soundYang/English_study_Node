import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 会话（md/33 §3.2）。
 *
 * 选会话表而不是 JWT 的理由：改密码要能让其它设备立刻失效。
 * JWT 要么等过期，要么再维护一张黑名单——多一张表，还不如一开始就用会话表。
 *
 * **库里只存 sha256 令牌**：备份泄露、日志误打都拿不到可用的令牌。
 * 令牌本身是 256 位随机数，不需要慢哈希（没有「口令空间」可以被穷举）。
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },

    // TTL 到期由 Mongo 后台线程清理（约每分钟一轮），所以**过期文档可能还在库里**。
    // 鉴权时必须自己判 expiresAt > now，不能只看「查得到就是有效」。
    expiresAt: { type: Date, required: true },

    // 这个会话原本发的是多久（1 天 / 30 天）。滑动续期要知道「续多久」，
    // 光看 expiresAt 推不出来——1 天的会话和 30 天的会话在同一时刻看起来是一样的
    ttlSeconds: { type: Number, required: true },

    // 每次请求都写库会拖慢读接口（生成页 1 秒一次轮询），service 里按分钟节流
    lastSeenAt: { type: Date, default: () => new Date() },
    userAgent: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

sessionSchema.index({ tokenHash: 1 }, { unique: true })
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
// 查「这个用户有哪些会话」并按新到旧排；顺带用于超出 10 个时踢掉最旧的
sessionSchema.index({ userId: 1, createdAt: -1 })

export const Session = mongoose.model('Session', sessionSchema)
