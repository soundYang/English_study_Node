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
      // basic-removed = 用户从基础词表里移除的词（md/06 §5.2）。
      // 它是一条 status=new 的占位记录：退出基础词白名单，也进不了候选池。
      enum: ['dictionary', 'manual', 'basic-removed'],
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

    // ——— 复习与复现统计（P1 新增，全部有默认值，老文档无需迁移）———

    lastReviewedAt: {
      type: Date,
      default: null, // 最近一次「在文章里复习到」的时间；提交练习时才回写，生成文章不算
    },
    articleExposureCount: {
      type: Number,
      default: 0, // 累计在生成文章的正文中出现过多少次
    },
    lastArticleExposureAt: {
      type: Date,
      default: null, // 最近一次进文章的时间；与 lastReviewedAt 的区别见 reading.service 的提交逻辑
    },
    cocaRank: {
      type: Number,
      default: null, // COCA 词频排名，越小越常用；手填词与源表里没有的词（an / yourselves）为 null
    },

    // ——— 复习调度（md/56，全部有默认值，老文档无需迁移）———

    reviewStage: {
      type: Number,
      default: 0, // 已通过的复习轮次数；0 = 还没复习过
    },
    nextReviewAt: {
      type: Date,
      default: null, // 下次到期时间；null = 不进复习队列（新词 / 已掌握 / 基础词墓碑）
    },
    lastResult: {
      type: String,
      enum: ['pass', 'lapse', null],
      default: null, // 最近一次自评结果
    },
    lapseCount: {
      type: Number,
      default: 0, // 累计「没记住」次数
    },
    masteredAt: {
      type: Date,
      default: null, // 自动转「已掌握」的时刻；手动改状态时由 service 维护
    },
  },
  { timestamps: true }, // 自动维护 createdAt / updatedAt，createdAt 就是「加入时间」
)

wordSchema.index({ userId: 1, word: 1 }, { unique: true }) // 同一用户内单词唯一，去重靠它而不是应用层 if
wordSchema.index({ userId: 1, createdAt: -1 }) // 列表默认按创建时间倒序
wordSchema.index({ userId: 1, status: 1, lastReviewedAt: 1 }) // P3 选池：按复习优先级取词，替代按 createdAt 截断
wordSchema.index({ userId: 1, status: 1, nextReviewAt: 1 }) // md/56：查「今天到期的复习词」

export const Word = mongoose.model('Word', wordSchema)
