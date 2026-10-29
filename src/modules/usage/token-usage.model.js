import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * token 流水（md/37 §4.3）。
 *
 * **每调一次模型写一条**，只追加、不更新。它回答的问题是「谁花了多少」，
 * 与 md/36 的全局计数器（只回答「还能不能继续服务」）分工不同：
 *
 *   tokenbudgets   单文档 $inc   全站剩余额度
 *   tokenusages    一行一次调用  按用户 / 按天 / 按任务拆分
 *
 * 为什么不在 reading 上存总额就够了：被取消的任务没有 reading，
 * 失败的任务也没有——那部分钱花出去了，却挂不到任何人头上。
 */
const tokenUsageSchema = new Schema(
  {
    // dataKey，不是 users._id（与 words / readings 同口径）
    userId: { type: String, required: true },
    // 由任务触发的调用才有；同步 /generate 为 null
    taskId: { type: Schema.Types.ObjectId, default: null },
    // generate / repair / plan / segment / finish / legacy（历史回填）
    kind: { type: String, default: 'generate' },
    model: { type: String, default: '' },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, required: true, min: 0 },
    // 这次调用花的是谁的额度（md/43 §7.1）：free = 全站免费池，user = 用户自备 Key。
    // 老文档没有这个字段，聚合时按 free 处理——那时还没有自备 Key
    keySource: { type: String, enum: ['free', 'user'], default: 'free' },
    // 北京时间 YYYY-MM-DD；按天聚合不依赖服务器时区
    day: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

tokenUsageSchema.index({ userId: 1, createdAt: -1 })
tokenUsageSchema.index({ userId: 1, day: 1 })
tokenUsageSchema.index({ taskId: 1 })

export const TokenUsage = mongoose.model('TokenUsage', tokenUsageSchema)
