import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 管理员会话（md/37 §2.3 / §4.1）。
 *
 * 与用户会话（`sessions`）**分成两张表**，不是为了整洁：
 * 用户令牌打管理端、管理员令牌打用户端，都必须是 401。
 * 共用一张表时，只要某个中间件忘了判角色，就越权了——
 * 独立集合 + 独立中间件是「结构上做不到」而不是「靠记得判」。
 *
 * 库里只存令牌的 sha256，与用户令牌同一套理由：令牌是 256 位随机数，
 * 不需要慢哈希，但绝不能明文落库。
 */
const adminSessionSchema = new Schema(
  {
    username: { type: String, required: true },
    tokenHash: { type: String, required: true },
    // 必须自己判 expiresAt > now：TTL 是后台线程清的，过期文档可能还躺着
    expiresAt: { type: Date, required: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

adminSessionSchema.index({ tokenHash: 1 }, { unique: true })
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const AdminSession = mongoose.model('AdminSession', adminSessionSchema)
