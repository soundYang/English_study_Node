import mongoose from 'mongoose'

import { QUESTION_TYPES } from './ai.schema.js'
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
    // W7：题型与原文依据。老文档没有这两个字段，读取方按 null / '' 兜底。
    // evidence 只在结果页出现——答题前给出依据等于把答案指出来
    type: { type: String, enum: QUESTION_TYPES, default: null },
    evidence: { type: String, default: '' },
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
 * 目标词覆盖度（W5）。M2 阶段只记录，不触发修复。
 * 数字口径由 target-coverage.js 唯一提供，这里只负责存。
 */
const targetUsageSchema = new Schema(
  {
    coverageRate: Number, // 出现过的不同目标词 / requiredWords
    totalOccurrences: Number, // 目标词总出现次数
    focusRepeatRate: Number, // 复现 ≥2 次的重点词 / 重点词数
    unused: { type: [String], default: [] }, // 一次都没出现的目标词
    overused: { type: [String], default: [] }, // 出现 > 6 次的词
    densityScore: Number, // 目标词 token / 正文 token
  },
  { _id: false },
)

/**
 * 难度客观指标（W7）。
 *
 * 六项都由 difficulty.js 从正文直接算出，不读模型自述——
 * 同一个难度标签下，分数应该聚在一起；分布散了就说明标签只是个名字。
 * M2 阶段只记录，阈值等采样分布出来再定。
 */
const difficultySchema = new Schema(
  {
    score: Number, // 0–100，六项加权
    metrics: {
      avgSentenceLength: Number, // 平均每句词数
      clauseDensity: Number, // 每句的从句标记数
      avgWordLength: Number, // 平均词长（字母数）
      passiveRatio: Number, // 含被动语态的句子占比
      tenseVariety: Number, // 出现过的时态/体数量
      medianRank: Number, // 词频中位数；排名表里一个都查不到时为 null
    },
  },
  { _id: false },
)

/**
 * 题目质量的非阻断提示（md/30 §10-7）。
 *
 * `detail_answer_overlap` = detail 题的正确答案与 evidence 实词重合不足一半。
 * 它**不再**触发 502：词面比较分不清「同义改写」和「毫无关系」，
 * 先攒频率，样本够了再决定要不要恢复成阻断规则。
 *
 * 故意不设 `default: []`：老文档上这个字段是 undefined，表示「当时没有检查」；
 * 新文档一定是 `[]`（检查过、没问题）。两者混成同一个值，统计时就没法排除旧样本。
 */
const questionWarningSchema = new Schema(
  {
    questionId: Number,
    code: String,
    message: String,
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
    // 段级硬上限 = maxWords × 1.15（md/30 §6-2）。和 actualWords 一起落库，
    // 才能回答「这一段是因为超长被重写的，还是因为生词」。
    limitWords: Number,
    attempts: Number, // 一共调了几次模型（含首轮与降级）
    actualWords: Number, // 最后一次尝试的实际词数
    // 收下时仍然超长：词表干净但压不下来，宁可留段也不丢（丢一段少 60 词）
    overLength: Boolean,
    accepted: Boolean, // 是否进入正文
    // 这段是否走过补段（md/27 §3.2 M1）：首轮被丢、第二轮又写了一次。
    // 用它算补段命中率，才知道 M1 到底救回了多少篇幅。
    refilled: Boolean,
    // md/41：这一段分到的生词额度（0 = 零容忍）。与 unknownWords 一起看，
    // 才知道某个生词是「被放行的」还是「校验漏了」
    unknownAllowance: Number,
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
      // md/43：free = 花全站免费池，user = 用户自备 Key。老文档为 undefined，按 free 读
      keySource: String,
      segments: { type: [segmentMetaSchema], default: [] }, // 整篇路径为空数组

      // ——— P1 扩展：P3 的覆盖度指标，也是 P6 回归对比的观察项 ———
      candidatePoolSize: Number, // 候选池大小
      requiredWords: Number, // 计划的目标词数
      targetUsage: { type: targetUsageSchema, default: null }, // W5：真实覆盖度六项
      difficulty: { type: difficultySchema, default: null }, // W7：难度分数与六项指标
      actualTargetWordCount: Number, // 实际用上的目标词数
      focusWordHits: Number, // 重点词平均复现次数
      userWordTokenRatio: Number, // 个人词占正文词次的比例
      wordCountDeviation: Number, // 实际篇幅 / targetWords，1 表示刚好
      // W6：按验收区间判的三态。short 默认只记录，MAX_EXPAND_ROUNDS>0 才补写
      lengthStatus: String, // ok / short / long
      violationsCount: Number, // 最终仍有几个违规词
      finishReason: String, // stop / length，用于判断是否被截断

      // ——— 生成快照（§3.3）：没有版本号，跨版本的两组采样不可比 ———
      basicWordsVersion: String, // 本次使用那一档 data/basic-words.*.json 的短 hash
      basicWordsLevel: String, // easy / medium / hard；配 hash 才有意义
      codeVersion: String, // git 提交号，读不到时为 'unknown'

      // ——— W8：把门禁数字也留一份 ———
      // 失败样本里已经有这几项；成功样本没有的话，同一批次没法解释「为什么这篇能过」
      knownWords: Number, // 个人词库 ∪ 该档基础表 ∪ 日历词
      // md/30 §7：按难度写死的 requiredKnown 改成随篇幅走的 minKnown。
      // 老文档上的 requiredKnown 保留原值（子文档是严格模式，新代码不再写它）
      requiredKnown: Number, // 旧字段，仅供历史样本对比
      minKnown: Number, // 写 targetWords 词所需的最低 knownWords
      personalWords: Number, // 个人词库条数（learning + mastered），最终模式的解锁口径
      finalMode: Boolean, // true = 最终模式（无目标词）
      coldStart: Boolean, // true = 冷启动（≤ 200 词只用基础词，无目标词，md/39）
      allowNewWords: Boolean, // true = 用户打开「允许少量生词」（仅 medium / hard，md/41）
      // 题目质量的非阻断提示；`[]` = 检查过没问题，undefined = 老文档未检查
      questionWarnings: { type: [questionWarningSchema] },
      // true = 在跳过已知词门槛的采样实例上生成（md/27 阶段二容量采样）。
      // 这类样本不能和线上样本一起算成功率：它们是刻意在门槛以下跑的
      knownGateSkipped: Boolean,
      unknownBudget: Number, // 该难度的生词预算
    },
  },
  { timestamps: true },
)

readingSchema.index({ userId: 1, createdAt: -1 }) // 历史列表默认排序
readingSchema.index({ userId: 1, level: 1, createdAt: -1 }) // 历史按难度筛选

export const Reading = mongoose.model('Reading', readingSchema)
