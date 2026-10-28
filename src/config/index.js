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

  // 生成策略
  vocabularyThreshold: toNumber('VOCABULARY_THRESHOLD', 20),
  // P0 基线：修 1 轮后 4/5 次只剩 1 个违规词，再给一轮的命中率远高于成本。
  // 2 轮意味着最坏情况一次生成调 3 次模型（方案 §12）
  maxRepairRounds: toNumber('MAX_REPAIR_ROUNDS', 2),
  // 篇幅压缩单独计数：实测一轮修完用词后只剩一次压缩机会，253 词只删到 239。
  // 给篇幅独立的一次机会，最坏情况 1 + 2 + 1 = 4 次调用。
  maxLengthRounds: toNumber('MAX_LENGTH_ROUNDS', 1),
  // 生词预算按难度取 level-limits.js：easy 0 / medium 3 / hard 5（md/20 §3）。
  // MAX_UNKNOWN_WORDS 仍然有效，但只作为**全局覆盖**：显式设置时三档压成同一个数，
  // 用于调试与回归对比；没设置时是 null，表示「按难度」。代码里请用
  // unknownBudgetFor(level, config.maxUnknownWordsOverride)，不要直接读下面的旧字段。
  maxUnknownWordsOverride: process.env.MAX_UNKNOWN_WORDS?.trim()
    ? toNumber('MAX_UNKNOWN_WORDS', 5)
    : null,
  // 兼容字段：文档与旧脚本还引用它，新代码不再读。
  maxUnknownWords: toNumber('MAX_UNKNOWN_WORDS', 5),
  basicWordsRank: toNumber('BASIC_WORDS_RANK', 3000),

  // 限流（次 / 分钟）
  rateLimitDictionary: toNumber('RATE_LIMIT_DICTIONARY', 60),
  rateLimitGenerate: toNumber('RATE_LIMIT_GENERATE', 20),
  rateLimitGlobal: toNumber('RATE_LIMIT_GLOBAL', 300),
})
