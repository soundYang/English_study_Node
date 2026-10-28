import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 全局免费 token 预算（md/36）。
 *
 * 整个服务只有一个文档（固定 _id），记录「免费 key 一共花掉多少 token」。
 * 与每日额度是两层不同的限制：
 *   · quotas —— 单个账号 / 设备每天能用几次（防个人滥用）；
 *   · 本文档 —— 全站累计花销上限（防整个免费池被吃穿）。
 *
 * 只存累计值，不存明细：明细在 Reading.aiMeta 与 GenerationFailure.rounds 里，
 * 这里要的是「能不能继续供给」这一个判断，多存一份反而会出现两个口径。
 */
const tokenBudgetSchema = new Schema(
  {
    // 固定值，保证只有一个计数器；用字符串而不是 ObjectId，方便直接读
    _id: { type: String, required: true },
    // 从启用时刻起累计的 token 总量（含失败、重试、取消的模型调用）
    usedTokens: { type: Number, required: true, default: 0, min: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
)

export const TokenBudget = mongoose.model('TokenBudget', tokenBudgetSchema)

export const FREE_BUDGET_ID = 'free-tokens'
