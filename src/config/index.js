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
  deepseekMaxTokens: toNumber('DEEPSEEK_MAX_TOKENS', 2600),

  // 生成策略
  vocabularyThreshold: toNumber('VOCABULARY_THRESHOLD', 20),
  maxRepairRounds: toNumber('MAX_REPAIR_ROUNDS', 1),
  basicWordsRank: toNumber('BASIC_WORDS_RANK', 800),

  // 限流（次 / 分钟）
  rateLimitDictionary: toNumber('RATE_LIMIT_DICTIONARY', 60),
  rateLimitGenerate: toNumber('RATE_LIMIT_GENERATE', 20),
  rateLimitGlobal: toNumber('RATE_LIMIT_GLOBAL', 300),
})
