import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 用户（md/33 §3.1）。
 *
 * **`dataKey` 才是业务集合里的 `userId`**，不是本表的 `_id`。
 * 分开的理由只有一个：历史数据全部挂在字符串 `'local-user'` 下，
 * 让第一个注册的人接管它，比批量改写几千条 `userId` 安全得多——
 * 批量改写不可回滚，写错一次就得从备份恢复。
 *
 *   users._id   ObjectId   身份，只在本表内使用
 *   users.dataKey  String  words / readings / generationtasks 里的 userId
 */
const userSchema = new Schema(
  {
    // 显示用，保留用户输入的大小写；查重与登录一律用 usernameLower
    username: { type: String, required: true, trim: true, maxlength: 20 },
    // 单独存小写：唯一索引加在原始字段上时，Alice 和 alice 会变成两个账号
    usernameLower: { type: String, required: true, maxlength: 20 },

    // 格式见 password.js：scrypt$N$r$p$salt$hash。库里永远没有明文
    passwordHash: { type: String, required: true },

    // 选填，且**不做验证**：没有短信/邮件渠道，它只是登录别名（md/33 §13-2）
    phone: { type: String, default: null, maxlength: 20 },

    // 为空时由注册流程填成 username；放在 service 而不是 default，
    // 因为默认值需要拿到同文档的另一个字段
    nickname: { type: String, default: '', trim: true, maxlength: 20 },
    signature: { type: String, default: '', trim: true, maxlength: 60 },

    dataKey: { type: String, required: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
)

userSchema.index({ usernameLower: 1 }, { unique: true })
userSchema.index({ dataKey: 1 }, { unique: true })

/**
 * 手机号唯一索引**必须用 partialFilterExpression，不能用 sparse**。
 *
 * sparse 只排除「字段不存在」的文档；而 Mongoose 的 `default: null` 会把 null
 * 真的写进去，于是第二个没填手机号的用户就会撞重复键——注册直接 500。
 * partial 只索引「值是字符串」的文档，null 与缺失都不进索引。
 */
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
)

export const User = mongoose.model('User', userSchema)
