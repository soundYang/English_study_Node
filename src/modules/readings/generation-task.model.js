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

/** 段级状态：只给进度用，不存正文（段级续跑属阶段二，见 md/31 §11） */
const segmentStateSchema = new Schema(
  {
    index: { type: Number, required: true }, // 1 起，与提示词里的段号一致
    status: {
      type: String,
      enum: ['pending', 'generating', 'accepted', 'dropped'],
      default: 'pending',
    },
    words: { type: Number, default: 0 }, // 收下时这一段的实际词数
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
      enum: ['queued', 'running', 'succeeded', 'failed'],
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
    },

    // done / total 都是「段」为单位，整篇路径没有段，恒为 0/0
    progress: {
      done: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    selectedWords: { type: [selectedWordSchema], default: [] },
    segments: { type: [segmentStateSchema], default: [] },

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
// TTL：任务只是状态机，24 小时后没人需要它了
generationTaskSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 })

export const GenerationTask = mongoose.model('GenerationTask', generationTaskSchema)
