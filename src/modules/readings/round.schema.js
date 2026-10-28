import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 一次模型调用的用量与诊断明细。
 *
 * 抽成独立文件给两个集合共用：`Reading.aiMeta.rounds`（成功样本）
 * 和 `GenerationFailure.rounds`（失败样本）。
 * 两边结构必须完全一致，否则失败样本没法拿来和成功样本对比——
 * 而对比正是这套诊断数据存在的理由。
 *
 * 新增的三个诊断字段对老文档是 undefined，读取方一律 `?? []` / `?? null`，
 * 不需要迁移。
 */
export const roundSchema = new Schema(
  {
    kind: { type: String, enum: ['generate', 'repair'], required: true },
    promptTokens: Number, // 输入 token
    completionTokens: Number, // 输出 token
    totalTokens: Number, // 输入 + 输出
    cacheHitTokens: Number, // 命中前缀缓存的输入 token，单价更低
    cacheMissTokens: Number, // 未命中的输入 token
    finishReason: String, // stop / length
    maxTokens: Number, // 当次请求的上限，排查截断用
    durationMs: Number, // 单次调用耗时
    actualWords: Number, // 这一轮正文实际词数，用于观察篇幅策略是否生效（结构不合法时为 null）

    // ——— 诊断字段：这一轮为什么发起、产出被判成什么 ———
    // 发起这一轮修正的原因；generate 轮没有上游原因，为 null
    repairFor: {
      type: String,
      enum: ['structure', 'vocabulary', 'word_count', 'word_expand'],
      default: null,
    },
    // 这一轮产出被判出的问题类型；null 表示这一轮通过了验收
    feedbackType: {
      type: String,
      enum: ['structure', 'vocabulary', 'word_count', 'word_expand'],
      default: null,
    },
    // 本轮正文里不在词表内的词（去重、按出现顺序）。
    // 篇幅超长时 evaluate() 会跳过词汇校验，这一轮就是空数组，不是「没有违规」。
    unknownWords: { type: [String], default: [] },
  },
  { _id: false },
)
