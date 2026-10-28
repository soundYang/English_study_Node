import mongoose from 'mongoose'

import { VIOLATION_CATEGORIES } from './vocabulary.service.js'

const { Schema } = mongoose

/**
 * 一轮的违规词分类计数。
 *
 * 键从 VIOLATION_CATEGORIES 生成，不手抄一份：分类名一旦加一处漏一处，
 * 「各分类占比」这类统计会静默少一列，而没人会发现。
 *
 * 只存计数不存 violations：原句只有当轮局部改写时有用，跑完就没用了，
 * 而 rounds 会跟着 Reading 永久保存，没必要为它胖几 KB。
 */
const violationCountsSchema = new Schema(
  Object.fromEntries(VIOLATION_CATEGORIES.map((category) => [category, Number])),
  { _id: false },
)

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
    // generate/repair = 整篇路径；plan/segment/finish = 分段路径（md/21 W4）。
    // 分段路径的段内重写记 repair，便于沿用「按 repairFor 归因」的报表口径。
    kind: {
      type: String,
      enum: ['generate', 'repair', 'plan', 'segment', 'finish'],
      required: true,
    },
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
    // questions = 正文合格、只有题目不合格（W7）
    repairFor: {
      type: String,
      enum: ['structure', 'questions', 'vocabulary', 'word_count', 'word_expand'],
      default: null,
    },
    // 这一轮产出被判出的问题类型；null 表示这一轮通过了验收
    feedbackType: {
      type: String,
      enum: ['structure', 'questions', 'vocabulary', 'word_count', 'word_expand'],
      default: null,
    },
    // 本轮正文里不在词表内的词（去重、按出现顺序）。
    // 篇幅超长时 evaluate() 会跳过词汇校验，这一轮就是空数组，不是「没有违规」。
    unknownWords: { type: [String], default: [] },
    // 本轮违规词按类别计数。undefined 与 unknownWords 的空数组同义：这一轮没查词汇。
    // 分类必须在生成当时落库：missing_common 依赖当前基础词表，而扩表（§4.2）
    // 之后回头分类旧样本，这类违规会凭空消失——正好抹掉扩表的依据。
    // proper_noun 也一样依赖大小写，而存下来的词形是小写的，事后无法复原。
    counts: { type: violationCountsSchema, default: undefined },
  },
  { _id: false },
)
