import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 每日学习流水（md/56 §10 P3）。
 *
 * **为什么要单独一张表**：`Word.lastReviewedAt` 只留「最后一次」，
 * 一个词周一复习、周三又复习，周一的痕迹就被覆盖了。
 * 想算「连续复习了几天」，必须有按天累积的记录，不能从词库反推。
 *
 * `date` 存 `YYYY-MM-DD` 字符串而不是 Date：
 *   1. 与 `localDateKey()` 完全同一个口径，不会出现「存的是 UTC 日期、算的是本地日期」；
 *   2. 唯一索引直接建在字符串上，不用再套一层日界聚合。
 *
 * 一个用户一天一条，`$inc` 累加。这份数据**从 P3 上线那天开始记**，
 * 之前的历史补不出来——`lastReviewedAt` 只能说明「最后一次是哪天」，
 * 反推会把「周一读过、周三又读」记录成「只在周三读过」。
 */
const studyDaySchema = new Schema(
  {
    userId: { type: String, required: true },
    date: { type: String, required: true }, // 本地日期 YYYY-MM-DD

    // 当天复习过的词次。同一个词一天复习两次算两次——这是「努力程度」，不是「覆盖词数」
    reviewed: { type: Number, default: 0 },
    // 当天新晋「已掌握」的词数
    mastered: { type: Number, default: 0 },
  },
  { timestamps: true },
)

// 一个用户一天只能有一条；并发 upsert 靠它兜底
studyDaySchema.index({ userId: 1, date: 1 }, { unique: true })

export const StudyDay = mongoose.model('StudyDay', studyDaySchema)
