import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 基础词的「认识」标记（md/52）。
 *
 * 只存「这个词我认得」，不存别的：
 *   · 有记录 = 认识；没有记录 = 没标过（未标记或已标不认识，看 Word 表）；
 *   · 「不认识」继续用 `Word{status:'new', source:'basic-removed'}`，
 *     因为生成链路要靠 status=new 把词从基础词白名单里减掉，这里不重复存。
 *
 * 为什么不用 Word 表存「认识」：那会让 650 个词进入「我的单词」、占用
 * WORD_LIBRARY_LIMIT，并被 countVocabulary 算进词汇量，直接改变生成门槛与篇幅上限。
 * 「认识」只是个人进度标记，不参与任何计算（md/52 §3）。
 */
const basicWordMarkSchema = new Schema(
  {
    userId: { type: String, required: true },
    word: { type: String, required: true }, // 规范化后的词形：小写、去首尾空格
  },
  { timestamps: true }, // createdAt = 标记认识的时间
)

basicWordMarkSchema.index({ userId: 1, word: 1 }, { unique: true })

export const BasicWordMark = mongoose.model('BasicWordMark', basicWordMarkSchema)
