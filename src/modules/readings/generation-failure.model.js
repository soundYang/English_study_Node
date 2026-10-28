import mongoose from 'mongoose'

import { roundSchema } from './round.schema.js'

const { Schema } = mongoose

/**
 * 违规词及所在原句，字段与 `validateArticle()` 的 `violations[]` 一一对应。
 *
 * `category` 故意不加 enum：分类表将来一定会加，而 schema 校验失败会让
 * 这一条样本整个被丢掉——诊断数据宁可多存一个不认识的类别，也不能丢样本。
 */
const violationSchema = new Schema(
  {
    token: { type: String, required: true }, // 原文形态，含大小写
    normalized: { type: String, required: true }, // 展开缩写、去所有格后的形式
    category: String, // abbreviation / proper_noun / wordform / missing_common / rare / unknown_token
    sentence: { type: String, default: '' },
  },
  { _id: false },
)

/**
 * 一次**失败**生成的完整留痕。
 *
 * 为什么需要它：生成失败时 `reading.service.js` 直接抛错，中间轮的违规词
 * （实测有 48 个、36 个）只进 pino 的 stdout，没有分母也没有回查入口，
 * 「连续 50–100 次任务的违规词分布」物理上统计不出来。
 *
 * 成功样本仍然只进 `Reading`，这里不复制一份——两边字段重合的部分
 * （参数、选池、rounds）保持同名，才可以直接对比。
 */
const generationFailureSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },

    // ——— 请求参数 ———
    level: String,
    targetWords: Number,
    questionCount: Number,
    scope: { type: [String], default: [] },

    // ——— 选池结果：排查「是不是池子太小」的唯一依据 ———
    available: Number,
    poolSize: Number,
    requiredWords: Number,
    allowedWordCount: Number, // 校验放行的词数（全部已学 + 基础 + 日历 + 缩写）
    promptWordCount: Number, // 提示词里列出的词数（候选池 + 基础 + 日历）

    // ——— 结果 ———
    errorCode: String, // 与前端约定一致的错误码，不是上游原始错误
    finalUnknownWords: { type: [String], default: [] },
    finalViolations: { type: [violationSchema], default: [] },
    // 最后一轮的正文（结构不合法时是模型的原始输出，便于区分「截断」和「格式错」）
    finalArticle: String,
    rounds: { type: [roundSchema], default: [] },
    repairRounds: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    durationMs: Number,
    model: String,

    // ——— 生成快照（§3.3）：失败样本和成功样本必须记同一套版本，否则没法同框对比 ———
    basicWordsVersion: String,
    codeVersion: String,
  },
  { timestamps: true },
)

// 调试期数据量会很快堆上去，30 天自动清理；同期文章不受影响
generationFailureSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 })
// 出分类报告时的主查询：按错误码聚合并按时间倒序
generationFailureSchema.index({ errorCode: 1, createdAt: -1 })

export const GenerationFailure = mongoose.model('GenerationFailure', generationFailureSchema)
