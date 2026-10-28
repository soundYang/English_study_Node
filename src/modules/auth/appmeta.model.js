import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 全站单例标记（md/33 §8）。
 *
 * 目前只有一个用途：决定谁是「第一个注册的用户」，让他接管 `local-user` 名下的历史数据。
 *
 * 为什么不用 `User.countDocuments() === 0`：
 * 两个请求同时读到 0，就都会去抢 `local-user`，最后两个账号共用一份数据。
 * 这种 bug 在本地永远复现不了，只在真实并发里出现一次。
 *
 * 这里利用的是「同一个 `_id` 只能插入成功一次」——插入成功者得，失败者拿到 11000。
 */
const appMetaSchema = new Schema(
  {
    // 'legacy-owner' 这样的固定字符串。用 String 而不是 ObjectId，
    // 是为了让「哪种标记」一眼可读，排查时不用去翻常量表
    _id: { type: String },
    claimedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    claimedAt: { type: Date, default: null },
  },
  { versionKey: false },
)

export const AppMeta = mongoose.model('AppMeta', appMetaSchema, 'appmeta')
