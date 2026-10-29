import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 生成任务（md/31）。
 *
 * 存在的理由只有一条：生成要跑几十秒、要调十几次模型，
 * 一次性 HTTP 请求既看不到进度，也经不起用户关一下页面。
 *
 * 任务表**只存状态**——正文始终在 `Reading` 里。
 * 所以 TTL 24 小时是安全的：过期后前端去历史页，文章并没有丢。
 */

/** 目标词条目：与 `newWords` 同形，前端可以复用同一个卡片组件 */
const selectedWordSchema = new Schema(
  {
    word: { type: String, required: true },
    // focus = 要求复现 2–3 次的重点词；target = 要求出现 1–2 次的普通目标词
    kind: { type: String, enum: ['focus', 'target'], required: true },
    phonetic: {
      uk: { type: String, default: '' },
      us: { type: String, default: '' },
    },
    senses: {
      type: [
        new Schema(
          {
            pos: { type: String, default: '' },
            meaning: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { _id: false },
)

/**
 * 段级状态。
 *
 * `text` 是**已收下的正文**，不是进度装饰：续跑时这些段不再调模型，
 * 直接拼回文章——这就是「失败只补失败段」省下来的钱（md/31 §11）。
 * 一段几百词，十段也就几 KB，任务文档的 16 MB 上限离得很远。
 */
const segmentStateSchema = new Schema(
  {
    index: { type: Number, required: true }, // 1 起，与提示词里的段号一致
    status: {
      type: String,
      enum: ['pending', 'generating', 'accepted', 'dropped'],
      default: 'pending',
    },
    words: { type: Number, default: 0 }, // 收下时这一段的实际词数
    attempts: { type: Number, default: 0 }, // 这一段一共调了几次模型
    text: { type: String, default: '' }, // 已收下的正文；dropped 时为空
  },
  { _id: false },
)

/**
 * 续跑所需的生成计划：提示词 + 分段表 + 已认出的专有名词。
 *
 * 为什么这三样都要存：缺一样都得重跑规划，而重跑规划会拿到**不同的分段**，
 * 已收下的段就和新段对不上号了。`limitWords` 尤其不能重算——
 * 它是按整篇预算分下来的份额，Σ 必须等于 acceptedMax。
 */
const planSchema = new Schema(
  {
    systemPrompt: { type: String, default: '' },
    segments: {
      type: [
        new Schema(
          {
            id: { type: Number, required: true },
            goal: { type: String, default: '' },
            maxWords: { type: Number, default: 0 },
            limitWords: { type: Number, default: 0 },
            mustUse: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    names: { type: [String], default: [] },
  },
  { _id: false },
)

const generationTaskSchema = new Schema(
  {
    userId: { type: String, required: true },

    /**
     * 前端生成的幂等键。**没有唯一索引**：空值不参与唯一约束这件事
     * MongoDB 能用 sparse 表达，但同一次点击重发两次的窗口只有毫秒级，
     * service 里「先查再建」已经够用——真重了也只是多花一次钱，而不是数据错。
     */
    clientToken: { type: String, default: null },

    status: {
      type: String,
      // cancelled 只由取消接口写入；被中断（进程重启）走 failed + TASK_INTERRUPTED
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
      default: 'queued',
    },
    // 阶段必须对应真实动作（md/31 §4）：不做定时器推进的假进度
    stage: {
      type: String,
      enum: ['queued', 'planning', 'generating', 'checking', 'saving', 'done'],
      default: 'queued',
    },

    // 请求参数原样存一份：任务复用时要比对，前端也要能显示「这是 600 词的」
    params: {
      level: String,
      targetWords: Number,
      questionCount: Number,
      vocabScope: { type: [String], default: [] },
      // md/41 / md/42：三态——true / false / 未设置（自动：最终模式默认开）。
      // 故意不设 default：把「没传」和「显式 false」混成一档，
      // 最终模式的任务重试时就会突然变严（md/42 §3）。
      allowNewWords: Boolean,
    },

    // done / total 都是「段」为单位，整篇路径没有段，恒为 0/0
    progress: {
      done: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    selectedWords: { type: [selectedWordSchema], default: [] },
    segments: { type: [segmentStateSchema], default: [] },
    // 续跑的输入；第一次跑到这里之前是 null
    plan: { type: planSchema, default: null },
    // 已认出的专有名词（随段级回调整体刷新）：续跑时缺的段要靠它们通过词表校验
    names: { type: [String], default: [] },
    // 续跑次数：0 = 第一次跑。用来区分「这篇是重试出来的」和正常生成
    retryCount: { type: Number, default: 0 },

    /**
     * 租约（md/31 §11 多实例）。
     *
     * owner        —— 正在执行这个任务的实例 id；null = 没有实例持有
     * heartbeatAt  —— 持有者的心跳时间。巡检只回收心跳过期的任务
     * cancelRequested —— 跨实例取消：取消请求可能落在别的实例上，
     *                    持有者在心跳与进度写回时读这个标记，读到就停手
     *
     * 没有这三样时，启动清理只能把全表的 queued/running 一律标失败——
     * 多实例下那等于「谁重启谁误杀别人」。
     */
    owner: { type: String, default: null },
    heartbeatAt: { type: Date, default: null },
    cancelRequested: { type: Boolean, default: false },

    /**
     * 这次任务占用的每日额度（md/35 §5.2）。
     *
     * keys       —— 占用了哪几个桶（acct: / dev: / net:）
     * day        —— 占用时属于北京时间的哪一天；退还必须退回到同一天的桶
     * refundedAt —— 退还时间。非空 = 已退，不能重复退（`releaseQuota` 会把 used 减成负数）
     *
     * 老任务没有这个字段，读取时一律 `?.` / `?? []`，不需要数据迁移。
     */
    quota: {
      keys: { type: [String], default: [] },
      day: { type: String, default: null },
      refundedAt: { type: Date, default: null },
    },

    readingId: { type: Schema.Types.ObjectId, default: null },
    error: {
      code: String,
      message: String,
      details: { type: Schema.Types.Mixed, default: null },
    },

    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    model: String,
    strategy: String,
  },
  { timestamps: true },
)

// 幂等查询：同一个 clientToken 只跑一次
generationTaskSchema.index({ userId: 1, clientToken: 1 })
// 并发闸门：找「这个用户还有没有在跑的」
generationTaskSchema.index({ userId: 1, status: 1 })
// 巡检：扫「running 且心跳过期」的任务
generationTaskSchema.index({ status: 1, heartbeatAt: 1 })
// TTL：任务只是状态机，24 小时后没人需要它了
generationTaskSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 })

export const GenerationTask = mongoose.model('GenerationTask', generationTaskSchema)
