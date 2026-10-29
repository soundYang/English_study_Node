import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 用户自备 API Key（md/43 §3）。
 *
 * **独立集合，不挂 users**：currentUser 每个带令牌的请求都会读一次 users，
 * 把密文放进去等于每次访问都把密文读进内存；而且删 Key / 轮换密文
 * 会和昵称、签名的并发更新共用同一条文档。
 *
 * 一个用户一个 provider 只有一条：唯一索引 + upsert，重复导入 = 覆盖。
 */
const userApiKeySchema = new Schema(
  {
    // dataKey，不是 users._id（与 words / readings / tokenusages 同口径）
    userId: { type: String, required: true },
    provider: { type: String, enum: ['deepseek'], required: true },

    // v1.<kid>.<iv>.<tag>.<ciphertext>；库里**永远没有明文**
    cipher: { type: String, required: true },
    // 掩码用；只存后 4 位
    last4: { type: String, required: true },
    // sha256(apiKey) 前 16 位：只能用来比对，不可逆
    fingerprint: { type: String, required: true },

    // active = 可尝试使用；invalid = 上游 401/403 过，等用户替换或重新校验
    status: { type: String, enum: ['active', 'invalid'], default: 'active' },
    lastVerifiedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

userApiKeySchema.index({ userId: 1, provider: 1 }, { unique: true })

export const UserApiKey = mongoose.model('UserApiKey', userApiKeySchema)
