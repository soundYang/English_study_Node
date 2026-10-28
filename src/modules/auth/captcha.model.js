import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 图形验证码（md/33 §3.3）。
 *
 * 一次一张：校验时用 `findOneAndDelete` 把「判断存在」与「消耗掉」合并成一次原子操作，
 * 同一个 captchaId 只能被用掉一次。并发猜两次时只有一个请求拿得到文档。
 *
 * 这条设计比图形本身更管用——图形只能提高单次成本，一次性才真正封死重放。
 *
 * 只存答案哈希：拖库时连未过期的验证码也拿不到。
 * 加盐用的是 captchaId（它本身就是随机 _id），所以彩虹表对这里没有意义。
 */
const captchaSchema = new Schema(
  {
    // sha256(`${_id}:${答案小写}`)；_id 在插入前已经生成，可以直接参与计算
    answerHash: { type: String, required: true },

    // 5 分钟。TTL 清理是后台的、有延迟，校验时仍要自己判 > now
    expiresAt: { type: Date, required: true },

    // 只记录，不参与判定：校园网、公司 NAT 下多个正常用户共用一个出口 IP 是常态
    ip: { type: String, default: '', maxlength: 64 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

captchaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const Captcha = mongoose.model('Captcha', captchaSchema)
