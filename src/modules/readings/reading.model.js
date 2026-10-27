import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 单道题目。
 * `_id: false` 只写在 Schema 选项里才能生效，写在对象里会变成一个布尔字段。
 */
const questionSchema = new Schema(
  {
    id: { type: Number, required: true }, // 题目序号，从 1 开始，练习内唯一
    question: { type: String, required: true }, // 题干（英文）
    options: { type: [String], required: true }, // 四个选项
    correctAnswer: { type: Number, required: true }, // 正确选项下标；只会出现在结果页 DTO 里
    explanation: { type: String, required: true }, // 答案解析（中文），同上
  },
  { _id: false },
)

const readingSchema = new Schema(
  {
    userId: { type: String, required: true }, // 所属用户
    title: { type: String, required: true }, // 文章标题
    article: { type: String, required: true }, // 英文正文，段落用 \n\n 分隔
    translation: { type: String, required: true }, // 中文翻译，仅结果页返回
    level: {
      type: String,
      enum: ['easy', 'medium', 'hard'], // 难度，与前端 choices 一致
      required: true,
    },
    targetWords: { type: Number, required: true }, // 目标词数，用户选的
    questionCount: { type: Number, required: true }, // 题目数量，用户选的
    actualWords: { type: Number, required: true }, // 实际词数；不落库的话历史统计要全表扫
    questions: { type: [questionSchema], required: true }, // 题目，含答案
    vocabularySnapshot: { type: [String], required: true }, // 生成时参与的用户词汇快照，最多 200 个
    names: { type: [String], default: [] }, // AI 声明的人名，词汇校验时放行用

    status: {
      type: String,
      enum: ['generated', 'submitted'], // generated=可作答；submitted=已判分
      default: 'generated',
    },
    userAnswers: {
      type: Map, // { [questionId]: 选项下标 | null }；Map 而不是 Object，避免数字键被转成字符串后难判类型
      of: Number,
      default: null, // 未提交时为 null
    },
    score: { type: Number, default: null }, // 百分制，四舍五入
    correctCount: { type: Number, default: null }, // 答对题数
    submittedAt: { type: Date, default: null }, // 提交时间

    aiMeta: {
      // 排查用，任何 DTO 都不返回
      model: String, // 实际调用的模型名
      promptTokens: Number, // 输入 token
      completionTokens: Number, // 输出 token
      repairRounds: Number, // 触发了几轮修正
    },
  },
  { timestamps: true },
)

readingSchema.index({ userId: 1, createdAt: -1 }) // 历史列表默认排序
readingSchema.index({ userId: 1, level: 1, createdAt: -1 }) // 历史按难度筛选

export const Reading = mongoose.model('Reading', readingSchema)
