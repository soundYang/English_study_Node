import mongoose from 'mongoose'

import { roundSchema } from './round.schema.js'

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
 * 正文里出现、但用户没学过的词（本次新增）。
 * 数量受该难度的生词预算限制（easy 0 / medium 3 / hard 5），随文章一起回给前端做折叠提示。
 */
const newWordSchema = new Schema(
  {
    word: { type: String, required: true },
    phonetic: {
      uk: { type: String, default: '' },
      us: { type: String, default: '' },
    },
    senses: [{ pos: String, meaning: String, _id: false }],
    // dictionary = 词典查到；abbreviation = 缩写表；unknown = 都没有，前端显示「暂无释义」
    source: { type: String, enum: ['dictionary', 'abbreviation', 'unknown'], default: 'unknown' },
  },
  { _id: false },
)

/**
 * 一次模型调用的用量明细（本次新增）。
 * 只记累计值会把「修了两轮」的真实成本抹掉，所以每轮单独一条。
 *
 * 结构定义在 round.schema.js：失败样本 GenerationFailure 也要用同一张表，
 * 定义分家就会慢慢长出两套字段。
 */

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
    // 最终正文里完全没出现的目标词（W4 只记录；W5 据此算 coverageRate）
    unused: { type: [String], default: [] },
  },
  { _id: false },
)

/**
 * 分段明细（W4）。只保留排查需要的数字：
 * 哪一段重写了几次、最后收没收、被丢掉的段里还有哪些生词。
 */
const segmentMetaSchema = new Schema(
  {
    id: Number,
    goal: String, // 规划阶段给出的方向（中文）
    maxWords: Number, // 计划篇幅
    attempts: Number, // 一共调了几次模型（含首轮与降级）
    actualWords: Number, // 最后一次尝试的实际词数
    accepted: Boolean, // 是否进入正文
    unknownWords: { type: [String], default: [] },
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
    // 放行给用户看的未学词（≤ 该难度的 unknownBudget），默认空数组，老文档不需要迁移
    newWords: { type: [newWordSchema], default: [] },

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
      // 排查用；只有 tokenUsage / actualWords 通过安全 DTO 回给前端
      model: String, // 实际调用的模型名
      promptTokens: Number, // 输入 token（**累计**，含所有修正轮）
      completionTokens: Number, // 输出 token（累计）
      totalTokens: Number, // 输入 + 输出（累计），用户看到的就是这个数
      rounds: { type: [roundSchema], default: [] }, // 每轮明细，排查费用与截断
      maxTokens: Number, // 当次请求的输出上限
      repairRounds: Number, // 触发了几轮修正（分段路径 = 段内重写次数之和）

      // ——— W4：生成路径与分段明细 ———
      strategy: String, // whole / segmented；老文档为 undefined
      segments: { type: [segmentMetaSchema], default: [] }, // 整篇路径为空数组

      // ——— P1 扩展：P3 的覆盖度指标，也是 P6 回归对比的观察项 ———
      candidatePoolSize: Number, // 候选池大小
      requiredWords: Number, // 计划的目标词数
      actualTargetWordCount: Number, // 实际用上的目标词数
      focusWordHits: Number, // 重点词平均复现次数
      userWordTokenRatio: Number, // 个人词占正文词次的比例
      wordCountDeviation: Number, // 实际篇幅 / targetWords，1 表示刚好
      violationsCount: Number, // 最终仍有几个违规词
      finishReason: String, // stop / length，用于判断是否被截断

      // ——— 生成快照（§3.3）：没有版本号，跨版本的两组采样不可比 ———
      basicWordsVersion: String, // 本次使用那一档 data/basic-words.*.json 的短 hash
      basicWordsLevel: String, // easy / medium / hard；配 hash 才有意义
      codeVersion: String, // git 提交号，读不到时为 'unknown'
    },
  },
  { timestamps: true },
)

readingSchema.index({ userId: 1, createdAt: -1 }) // 历史列表默认排序
readingSchema.index({ userId: 1, level: 1, createdAt: -1 }) // 历史按难度筛选

export const Reading = mongoose.model('Reading', readingSchema)
