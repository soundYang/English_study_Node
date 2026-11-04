import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 词库导入记录（md/63 §4.4）。
 *
 * 只记录“这个词是从哪个词库导入到个人词库的”：
 *   · 有记录 = 导入词，重置该词库时要删；
 *   · 没有记录 = 用户原有词 / 手动添加词，重置不碰。
 *
 * `analysis` 即使出现在高频词库目录里，只要用户原本就有，就不会有这条记录，
 * 因此不会被重置误删。
 */
const wordBankMembershipSchema = new Schema(
  {
    userId: { type: String, required: true },
    word: { type: String, required: true },
    bank: { type: String, enum: ['high', 'mid'], required: true },
    importedAt: { type: Date, required: true },
    addedBy: { type: String, enum: ['manual', 'bulk'], default: 'manual' },
  },
  { timestamps: true },
)

// 同一个词在同一个词库只能有一条导入记录；重复导入靠唯一索引兜底
wordBankMembershipSchema.index({ userId: 1, word: 1, bank: 1 }, { unique: true })
// 词库页“已导入”筛选、概要统计、重置都按 userId + bank 查
wordBankMembershipSchema.index({ userId: 1, bank: 1, importedAt: -1 })

export const WordBankMembership = mongoose.model(
  'WordBankMembership',
  wordBankMembershipSchema,
)
