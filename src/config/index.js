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

/**
 * 允许的浏览器来源（CORS），逗号分隔。
 *
 * 支持多源是为了局域网联调：本机用 `http://localhost:5173`、手机用
 * `http://192.168.x.x:5173`，两者是不同的 Origin，单值配置必然拦掉一个。
 * 写成字符串数组而不是正则，是因为这里只该放明确知道的站点——
 * 用 `*` 会把接口对任意网页开放，将来带 Cookie 时更是直接失效。
 */
function readClientOrigins() {
  const raw = process.env.CLIENT_ORIGIN ?? ''
  const list = raw
    .split(',')
    .map((item) => item.trim())
    // 末尾斜杠会让 `https://a.com/` 与浏览器发来的 `https://a.com` 对不上
    .map((item) => item.replace(/\/+$/, ''))
    .filter(Boolean)

  return list.length > 0 ? list : ['http://localhost:5173']
}

/**
 * Express 的 `trust proxy` 取值（md/35 §3.4）。
 *
 * 不给值时返回 false，与 Express 默认一致。生产在 nginx / Cloudflare 后面时必须设：
 * 否则 `req.ip` 全是反代地址，网络指纹会退化成「全站一个桶」。
 *
 * 支持：true / false / 跳数（0、1、2）/ loopback|linklocal|uniquelocal。
 * 写错时启动即炸——静默退回 false 的话，症状是「上线当天所有人共用额度」，
 * 排查时很难联想到这是一行配置。
 */
function readTrustProxy() {
  const raw = process.env.TRUST_PROXY?.trim()
  if (!raw) return false
  if (raw === 'true') return true
  if (raw === 'false') return false

  const hops = Number(raw)
  if (Number.isInteger(hops) && hops >= 0) return hops

  if (['loopback', 'linklocal', 'uniquelocal'].includes(raw)) return raw

  console.error(
    `[config] 环境变量 TRUST_PROXY 只能是 true / false / 跳数 / loopback / linklocal / uniquelocal，当前值：${raw}`,
  )
  process.exit(1)
}

export const config = Object.freeze({
  // 服务
  port: toNumber('PORT', 3000),
  nodeEnv,
  // 逗号分隔多源；局域网联调时把 `http://<本机IP>:5173` 也加进来
  clientOrigins: readClientOrigins(),
  // 反代后面必须配置，否则 req.ip 不可信（见上方 readTrustProxy）
  trustProxy: readTrustProxy(),

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
  // 个人词库上限（md/44 §5.6）。生成前 `findVocabulary` 是全量拉取，
  // 词库过大时白花时间与内存；0 = 不限。5000 远高于真实用量（基础词 650 + 手填）
  wordLibraryLimit: toNumber('WORD_LIBRARY_LIMIT', 5000),
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

  // 已知词门槛（B 门）的**跳过开关**，只给 md/27 阶段二采样用。
  // 要测「写 N 词至少需要多少已知词」，就必须能跑低于当前门槛的样本；
  // 否则只在已经过门的点上采样，测出来的是门槛本身，不是能力边界。
  // A 门（候选池够不够目标词）不跳：它决定目标词能不能凑齐，是产品约束。
  // 默认 false；生产环境打开等于取消准入。
  skipKnownWordsGate: readBoolean('SKIP_KNOWN_WORDS_GATE', false),

  // 任务租约（md/31 §11 多实例）
  // 执行实例每 taskHeartbeatMs 续一次租；心跳超过 taskStaleMs 没更新才算失联。
  // 阈值至少要是心跳的 3 倍：一次慢查询或 GC 抖动不该把自己的任务判死。
  taskHeartbeatMs: toNumber('TASK_HEARTBEAT_MS', 15_000),
  taskStaleMs: toNumber('TASK_STALE_MS', 60_000),

  // ——— 日志落库（md/53）———
  // 访问日志：一次请求一条，含 IP，默认保留 30 天。
  // 测试环境默认关闭：900+ 个用例每个都发请求，开着会让测试多出几万次写库。
  accessLogEnabled: readBoolean('ACCESS_LOG_ENABLED', nodeEnv !== 'test'),
  accessLogRetentionDays: toNumber('ACCESS_LOG_RETENTION_DAYS', 30),
  // 报错日志：只记 5xx，比访问日志少得多，默认留 90 天
  errorLogEnabled: readBoolean('ERROR_LOG_ENABLED', nodeEnv !== 'test'),
  errorLogRetentionDays: toNumber('ERROR_LOG_RETENTION_DAYS', 90),

  // 限流（次 / 分钟）
  // 总开关：测试环境默认关闭。开着的话一个 50 次预检的验收用例会把后面的用例
  // 一起打成 429，且失败位置看起来跟限流毫无关系。要验证限流本身的用例
  // 在文件顶部把 RATE_LIMIT_ENABLED 设成 true 再动态 import 即可。
  rateLimitEnabled: readBoolean('RATE_LIMIT_ENABLED', nodeEnv !== 'test'),
  // 只有生成接口挂限流（W9）：词库检索是纯读内存、不花钱，全局限流会顺带限掉
  // 前端每拖一次滑块就要调一次的 /capacity。dictionary / global 两个旋钮没有
  // 任何中间件在读，已于 2026-10-28 删除——留着只会让人以为它们生效。
  rateLimitGenerate: toNumber('RATE_LIMIT_GENERATE', 20),

  // ——— 鉴权（md/33）———
  // 强制鉴权开关。默认 false = 行为与无登录时完全一致（回落 DEFAULT_USER_ID）。
  // 打开前前端必须先上线登录页，否则整站立刻 401（md/33 §7.3）。
  authEnforced: readBoolean('AUTH_ENFORCED', false),
  // 验证码是纯计算、不花钱，可以宽松；注册与登录直接决定账号安全，必须紧。
  // 注册按小时计：一个人正常只注册一次，10 次/时已经宽得离谱。
  rateLimitCaptcha: toNumber('RATE_LIMIT_CAPTCHA', 30),
  rateLimitRegister: toNumber('RATE_LIMIT_REGISTER', 10),
  rateLimitLogin: toNumber('RATE_LIMIT_LOGIN', 10),
  // 改密码要跑两次 scrypt（校验旧的 + 生成新的），比只读接口贵得多
  rateLimitPassword: toNumber('RATE_LIMIT_PASSWORD', 5),

  // ——— 文件导入与 OCR（md/48）———
  // OCR 解析是唯一会把 CPU 打满的接口，单独给一个开关：
  // 关掉后图片上传直接 422 OCR_FAILED，Word / Excel 不受影响
  ocrEnabled: readBoolean('OCR_ENABLED', true),
  // 只认英文（快速模式）。改成 eng+chi_sim 会同时加载中文模型，
  // 体积从 4MB 涨到 24MB，且中文识别错误会污染释义——见 md/48 §7.2
  ocrLang: (process.env.OCR_LANG ?? 'eng').trim() || 'eng',
  // 模型目录。留空 = 用仓库自带的 data/ocr（见 ocr.js 的 BUNDLED_LANG_DIR），
  // 该目录不存在时才退回 tesseract 的 CDN——那种情况下服务器必须有外网
  ocrLangPath: (process.env.OCR_LANG_PATH ?? '').trim(),
  // 模型缓存目录。留空 = 不写缓存：模型本来就放在本地，
  // tesseract 默认会往工作目录写一个 4MB 的 eng.traineddata
  ocrCachePath: (process.env.OCR_CACHE_PATH ?? '').trim(),
  // 单张图识别超时。超时后 worker 会被销毁重建，不会拖住后续请求
  ocrTimeoutMs: Math.max(1000, toNumber('OCR_TIMEOUT_MS', 20_000)),
  // worker 池大小。每个 worker 是一个独立线程 + 几十 MB 内存，
  // 调大只在「很多人同时传图」时才有意义。
  // 下限 1：填 0 会让 acquire() 永远等不到 worker，请求全部挂死
  ocrWorkers: Math.max(1, toNumber('OCR_WORKERS', 2)),

  // ——— 导入的 AI 识别（md/49）———
  // 能力总开关。**注意它不等于「功能默认开」**：请求默认 mode=local，
  // 只有前端显式传 mode=ai 且账号接了自备 Key 才会调模型。
  // 这里关掉是止血阀：mode=ai 一律 403，本地解析不受影响
  importAiEnabled: readBoolean('IMPORT_AI_ENABLED', true),
  // 分片：每片最多多少行 / 多少字符。输出上限是 MAX_OUTPUT_TOKENS(8192)，
  // 150 行 × 约 28 token ≈ 4.2k，留足余量；4 片 × 150 = 600 ≥ MAX_IMPORT_ROWS(500)
  importAiMaxRowsPerCall: Math.max(10, toNumber('IMPORT_AI_MAX_ROWS_PER_CALL', 150)),
  importAiMaxCharsPerCall: Math.max(500, toNumber('IMPORT_AI_MAX_CHARS_PER_CALL', 6000)),
  importAiMaxCalls: Math.max(1, toNumber('IMPORT_AI_MAX_CALLS', 4)),
  // 整次请求的时间预算。前端为这一路单独设 60s，后端 45s 先收口，
  // 保证「后端失败」比「前端超时」先发生，用户看到的是明确错误而不是网络异常
  importAiTimeoutMs: Math.max(1000, toNumber('IMPORT_AI_TIMEOUT_MS', 45_000)),
  // 按用户限流（次 / 小时）。**不按 IP**：同一出口（宿舍 / 公司）会互相误伤
  importAiUserLimit: Math.max(1, toNumber('IMPORT_AI_USER_LIMIT', 10)),

  // ——— 每日额度（md/35）———
  // md/35 Q4：前端 X-Device-Id 已上线，默认打开；测试由 setup.js 固定为 false，
  // 批量采样实例启动时显式 `DAILY_QUOTA_ENABLED=false`（网络桶 10 次/天会打成 429）
  dailyQuotaEnabled: readBoolean('DAILY_QUOTA_ENABLED', true),
  // 账号与设备都是 3 次/天：换账号会被设备挡住，换浏览器会被账号挡住
  dailyQuotaAccount: toNumber('DAILY_QUOTA_ACCOUNT', 3),
  dailyQuotaDevice: toNumber('DAILY_QUOTA_DEVICE', 3),
  // 网络指纹是兜底：清 localStorage、换无痕窗口都还能被它兜住。
  // 共享出口（宿舍 / 公司）会按人头叠加，调小时注意误伤
  dailyQuotaNetwork: toNumber('DAILY_QUOTA_NETWORK', 10),

  // ——— 用户自备 API Key（md/43）———
  // 有效开关 = 这个布尔 && secret 非空。缺 secret 时按关闭处理：
  // 存量密文无法解密，继续用只会让每次生成都白跑一次解密
  userApiKeyEnabled: readBoolean('USER_API_KEY_ENABLED', true),
  // AES-256-GCM 主密钥，用 scripts/gen-user-key-secret.mjs 生成，仓库里永远没有
  userApiKeySecret: (process.env.USER_API_KEY_SECRET ?? '').trim(),
  // 轮换时只用于解密：先配 PREVIOUS，确认所有用户重新导入后再删旧值
  userApiKeySecretPrevious: (process.env.USER_API_KEY_SECRET_PREVIOUS ?? '').trim(),
  // 导入时校验 /models 的超时；比生成超时短得多，导入是同步接口
  userApiKeyVerifyTimeoutMs: toNumber('USER_API_KEY_VERIFY_TIMEOUT_MS', 8000),
  // 导入 / 删除 / 校验共用的按 IP 限流（次 / 分钟）
  rateLimitApiKey: toNumber('RATE_LIMIT_API_KEY', 5),

  // ——— 全局免费 token 预算（md/36）———
  // 与每日额度是两层限制：上面管「一个人一天几次」，这里管「全站还能花多少」。
  // 计数发生在每一次模型调用（含失败 / 重试 / 取消），不是每篇成功文章。
  tokenBudgetEnabled: readBoolean('TOKEN_BUDGET_ENABLED', true),
  // 免费池总量。2 亿 token ≈ 按 2026-10-28 实测均值（约 4.2 万 token / 篇）
  // 约 4700 篇。到顶后所有生成返回 503 FREE_BUDGET_EXHAUSTED
  freeTokenBudget: toNumber('FREE_TOKEN_BUDGET', 200_000_000),

  // ——— 管理员后台（md/37）———
  // 单账号，不建 admins 表。**两项都为空时 /api/admin/* 整体不挂载**（404），
  // 避免「先启动、登录时才发现没配置」的未鉴权窗口。
  adminUsername: (process.env.ADMIN_USERNAME ?? '').trim(),
  // scrypt 字符串；用 scripts/hash-admin-password.mjs 生成。
  // 仓库里永远不出现明文密码
  adminPasswordHash: (process.env.ADMIN_PASSWORD_HASH ?? '').trim(),
})
