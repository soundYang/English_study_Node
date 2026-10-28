import 'dotenv/config'

/**
 * 配置入口：读 .env → 校验必填 → 导出冻结对象。
 *
 * 缺失的关键配置必须在这里就炸掉，而不是等第一个请求进来才发现——
 * 那样排查时会先怀疑业务代码，浪费的时间远多于启动时多看一眼日志。
 */

const nodeEnv = process.env.NODE_ENV || 'development'

/** 任何环境都必填：没有数据库地址，服务即使起来了也做不了任何事 */
const REQUIRED_ALWAYS = ['MONGODB_URI']

/** 只有生产环境必填：S0–S5 阶段（骨架、词汇 CRUD、词库检索）根本不调 AI */
const REQUIRED_IN_PRODUCTION = ['DEEPSEEK_API_KEY']

const required =
  nodeEnv === 'production'
    ? [...REQUIRED_ALWAYS, ...REQUIRED_IN_PRODUCTION]
    : REQUIRED_ALWAYS

// 用 trim 判断，避免 .env 里写成 `MONGODB_URI=`（空串）也算填了
const missing = required.filter((key) => !process.env[key]?.trim())
if (missing.length > 0) {
  console.error(`[config] 缺少环境变量：${missing.join(', ')}`)
  console.error('[config] 请复制 .env.example 为 .env 后补齐，再重新启动。')
  process.exit(1)
}

/**
 * 数字型配置统一转换。
 * 不转的话 process.env 里全是字符串，`'60' > 9` 为 false 这类比较会静默出错。
 */
function toNumber(key, fallback) {
  const raw = process.env[key] ?? String(fallback)
  const value = Number(raw)

  if (!Number.isFinite(value)) {
    console.error(`[config] 环境变量 ${key} 必须是数字，当前值：${raw}`)
    process.exit(1)
  }

  return value
}

/** 布尔型配置：只认 true/false（以及 1/0），写错时启动即炸 */
function readBoolean(key, fallback) {
  const raw = process.env[key]?.trim().toLowerCase()

  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false

  console.error(`[config] 环境变量 ${key} 只能是 true / false，当前值：${process.env[key]}`)
  process.exit(1)
}

/** 枚举型配置：写错时启动即炸，而不是等第一个请求走进未定义分支 */
function readEnum(key, allowed, fallback) {
  const raw = (process.env[key] || fallback).trim()

  if (!allowed.includes(raw)) {
    console.error(`[config] 环境变量 ${key} 只能是 ${allowed.join(' / ')}，当前值：${raw}`)
    process.exit(1)
  }

  return raw
}

export const config = Object.freeze({
  // 服务
  port: toNumber('PORT', 3000),
  nodeEnv,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  // 数据库
  mongodbUri: process.env.MONGODB_URI,

  // 用户（MVP 无登录，所有请求都归属这一个用户）
  defaultUserId: process.env.DEFAULT_USER_ID || 'local-user',

  // DeepSeek
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  deepseekTimeoutMs: toNumber('DEEPSEEK_TIMEOUT_MS', 60_000),
  // 输出 token 上限。这是**上限不是计费项**，按实际 completion_tokens 计费，
  // 所以给足模型上限（deepseek-chat 为 8192）比按篇幅估算更安全：
  // 估小了会被截断成 AI_INVALID_RESPONSE，用户看到的是「生成失败」而不是「文章有点长」。
  maxOutputTokens: toNumber('MAX_OUTPUT_TOKENS', 8192),

  // 生成策略（md/20 §5.5）
  //   segmented —— 规划 → 分段闭环 → 收尾（默认，md/21 W4）
  //   whole     —— 一次性整篇生成 + 整篇修正（旧路径，保留用于 A/B 与问题定位）
  generationStrategy: readEnum('GENERATION_STRATEGY', ['whole', 'segmented'], 'segmented'),
  // 分段并发：4 是 md/20 §5.4 的成本/延迟平衡点；再高只会让上游限流
  segmentConcurrency: toNumber('SEGMENT_CONCURRENCY', 4),
  // 每段允许的**重写**次数（不含首轮，也不含最后那次「更简单的说法」）
  segmentMaxAttempts: toNumber('SEGMENT_MAX_ATTEMPTS', 2),
  // 分段路径的温度：约束性文本用 0.8 等于给自己制造违规（md/21 W4）
  segmentTemperature: toNumber('SEGMENT_TEMPERATURE', 0.5),
  // 补段轮数（md/27 §3.2 M1）：段被丢弃后，把这些空槽用原目标再写一遍的次数。
  // 1 = 最多补一轮。调大能救更零散的丢段，但 hard 单次已经在 25 轮上下，再翻倍不值。
  segmentRefillRounds: toNumber('SEGMENT_REFILL_ROUNDS', 1),
  // 段接收率下限（md/23 D2）：低于这个比例就判生成失败，不再把残篇当 201 返回。
  // 0.6 取自 md/23 D2 的建议值；easy 300 曾出现「计划 5 段只收 1 段」的 20%。
  minSegmentAcceptance: toNumber('MIN_SEGMENT_ACCEPTANCE', 0.6),

  vocabularyThreshold: toNumber('VOCABULARY_THRESHOLD', 20),
  // P0 基线：修 1 轮后 4/5 次只剩 1 个违规词，再给一轮的命中率远高于成本。
  // 2 轮意味着最坏情况一次生成调 3 次模型（方案 §12）
  maxRepairRounds: toNumber('MAX_REPAIR_ROUNDS', 2),
  // 篇幅压缩单独计数：实测一轮修完用词后只剩一次压缩机会，253 词只删到 239。
  // 给篇幅独立的一次机会，最坏情况 1 + 2 + 1 = 4 次调用。
  maxLengthRounds: toNumber('MAX_LENGTH_ROUNDS', 1),
  // 偏短扩写（md/21 W6）：默认 0 = 只记录 `aiMeta.lengthStatus`，不追加调用。
  // 实测扩写一轮只多写十几词，收益不高；先靠采样看 short 的比例再决定是否默认开。
  maxExpandRounds: toNumber('MAX_EXPAND_ROUNDS', 0),
  // 生词预算按难度取 level-limits.js：easy 0 / medium 3 / hard 5（md/20 §3）。
  // MAX_UNKNOWN_WORDS 仍然有效，但只作为**全局覆盖**：显式设置时三档压成同一个数，
  // 用于调试与回归对比；没设置时是 null，表示「按难度」。代码里请用
  // unknownBudgetFor(level, config.maxUnknownWordsOverride)，不要直接读下面的旧字段。
  maxUnknownWordsOverride: process.env.MAX_UNKNOWN_WORDS?.trim()
    ? toNumber('MAX_UNKNOWN_WORDS', 5)
    : null,
  // 兼容字段：文档与旧脚本还引用它，新代码不再读。
  maxUnknownWords: toNumber('MAX_UNKNOWN_WORDS', 5),

  // 篇幅上限的**全局覆盖**，只给采样实例用（md/26）。
  // 没设置时是 null，表示按难度取 `LEVEL_LIMITS[level].maxTargetWords`；
  // 显式设置时三档压成同一个数，用于验证「700/800 词到底写不写得出」。
  // 与 MAX_UNKNOWN_WORDS 是同一套覆盖模式：调试旋钮，不是产品参数。
  maxTargetWordsOverride: process.env.MAX_TARGET_WORDS?.trim()
    ? toNumber('MAX_TARGET_WORDS', 600)
    : null,

  // 限流（次 / 分钟）
  // 总开关：测试环境默认关闭。开着的话一个 50 次预检的验收用例会把后面的用例
  // 一起打成 429，且失败位置看起来跟限流毫无关系。要验证限流本身的用例
  // 在文件顶部把 RATE_LIMIT_ENABLED 设成 true 再动态 import 即可。
  rateLimitEnabled: readBoolean('RATE_LIMIT_ENABLED', nodeEnv !== 'test'),
  // 只有生成接口挂限流（W9）：词库检索是纯读内存、不花钱，全局限流会顺带限掉
  // 前端每拖一次滑块就要调一次的 /capacity。dictionary / global 两个旋钮没有
  // 任何中间件在读，已于 2026-10-28 删除——留着只会让人以为它们生效。
  rateLimitGenerate: toNumber('RATE_LIMIT_GENERATE', 20),
})
