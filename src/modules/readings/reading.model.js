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

/**
 * 本次生成的选池与目标词计划（P1 新增）。
 * 排查「这篇文章为什么这么难写」时，光看正文没用，得知道当时给了模型什么条件。
 */
const targetPlanSchema = new Schema(
  {
    scope: { type: [String], default: [] }, // 词源：['all'] / ['today_new','today_reviewed']
    poolSize: { type: Number, default: 0 }, // 候选池实际大小
    requiredWords: { type: Number, default: 0 }, // 按篇幅算出的目标词数
    focusWords: { type: [String], default: [] }, // 重点词清单，要求复现 2–3 次
  },
  { _id: false },
)

/**
 * 正文里实际出现的个人词及次数（P1 新增）。
 * 不统计基础词——没有复习价值，还会把数组撑到几百条。
 */
const usedWordSchema = new Schema(
  {
    word: { type: String, required: true },
    count: { type: Number, required: true, min: 0 }, // 正文实际出现次数
    kind: {
      type: String,
      enum: ['focus', 'target', 'pool'], // 重点词 / 普通目标词 / 池内但未入选目标词
      required: true,
    },
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
    vocabularySnapshot: { type: [String], required: true }, // 生成时参与的用户词汇快照，最多 800 个
    names: { type: [String], default: [] }, // AI 声明的人名，词汇校验时放行用

    // ——— P1 新增：生成计划与实际复现，老文档没有时分别取 null / [] ———
    targetPlan: { type: targetPlanSchema, default: null },
    usedWords: { type: [usedWordSchema], default: [] },

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

      // ——— P1 扩展：P3 的覆盖度指标，也是 P6 回归对比的观察项 ———
      candidatePoolSize: Number, // 候选池大小
      requiredWords: Number, // 计划的目标词数
      actualTargetWordCount: Number, // 实际用上的目标词数
      focusWordHits: Number, // 重点词平均复现次数
      userWordTokenRatio: Number, // 个人词占正文词次的比例
      wordCountDeviation: Number, // 实际篇幅 / targetWords，1 表示刚好
      violationsCount: Number, // 最终仍有几个违规词
      finishReason: String, // stop / length，用于判断是否被截断
    },
  },
  { timestamps: true },
)

readingSchema.index({ userId: 1, createdAt: -1 }) // 历史列表默认排序
readingSchema.index({ userId: 1, level: 1, createdAt: -1 }) // 历史按难度筛选

export const Reading = mongoose.model('Reading', readingSchema)
