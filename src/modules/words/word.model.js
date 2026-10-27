import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 义项快照。
 *
 * 独立成 Schema 而不是内联对象：只有写在 Schema 选项里的 `_id: false`
 * 才会真正关掉子文档主键；写成 `_id: false` 字段会被当成一个同名字段存进库。
 */
const senseSchema = new Schema(
  {
    pos: { type: String, default: '' }, // 词性缩写，如 n. / v. / adj.；手填词为空串
    meaning: { type: String, required: true }, // 中文释义，最长 200 字符
  },
  { _id: false },
)

/** 音标快照；手填词整体为 null，词库词内部两项可以为 null */
const phoneticSchema = new Schema(
  {
    uk: { type: String, default: null }, // 英式音标，含 /.../
    us: { type: String, default: null }, // 美式音标，含 /.../
  },
  { _id: false },
)

const wordSchema = new Schema(
  {
    userId: { type: String, required: true }, // 所属用户；MVP 无登录，恒为 local-user
    word: { type: String, required: true }, // 规范化后的词形：小写、去首尾空格
    status: {
      type: String,
      enum: ['new', 'learning', 'mastered'], // 新词 / 学习中 / 已掌握，与前端 WORD_STATUSES 一致
      default: 'learning', // 新增词默认「学习中」
    },
    source: {
      type: String,
      enum: ['dictionary', 'manual'], // dictionary=命中词库并落快照；manual=手填
      required: true,
    },
    dictionaryId: { type: String, default: null }, // 词条溯源 ID，形如 dict_abandon；手填为 null
    phonetic: {
      type: phoneticSchema,
      default: null, // 手填词整体为 null，前端据此不渲染音标行
    },
    senses: {
      type: [senseSchema], // 义项快照；手填至多一条且 pos 为空串
      default: [],
    },
  },
  { timestamps: true }, // 自动维护 createdAt / updatedAt
)

wordSchema.index({ userId: 1, word: 1 }, { unique: true }) // 同一用户内单词唯一，去重靠它而不是应用层 if
wordSchema.index({ userId: 1, createdAt: -1 }) // 列表默认按创建时间倒序

export const Word = mongoose.model('Word', wordSchema)
