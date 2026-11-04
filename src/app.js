import cors from 'cors'
import express from 'express'
import helmet from 'helmet'

import { config } from './config/index.js'
import adminRoutes from './modules/admin/admin.routes.js'
import { isAdminConfigured } from './modules/admin/admin.service.js'
import authRoutes from './modules/auth/auth.routes.js'
import { requireAuth, requireSession } from './modules/auth/auth.middleware.js'
import profileRoutes from './modules/auth/profile.routes.js'
import publicBasicWordRoutes from './modules/basic-words/basic-words.public.routes.js'
import basicWordRoutes from './modules/basic-words/basic-words.routes.js'
import dictionaryRoutes from './modules/dictionary/dictionary.routes.js'
import feedbackRoutes from './modules/feedback/feedback.routes.js'
import healthRoutes from './modules/health/health.routes.js'
import quotaRoutes from './modules/quota/quota.routes.js'
import readingRoutes from './modules/readings/reading.routes.js'
import wordBankRoutes from './modules/word-banks/word-banks.routes.js'
import wordRoutes from './modules/words/word.routes.js'
import { ERROR_CODES } from './shared/errors.js'
import { accessLogger } from './shared/middleware/accessLog.js'
import { currentUser } from './shared/middleware/currentUser.js'
import { errorHandler } from './shared/middleware/errorHandler.js'
import { createGlobalLimiter } from './shared/middleware/rateLimit.js'
import { requestLogger } from './shared/middleware/requestLogger.js'

/**
 * 全局兜底限流（md/45 M5）：按 IP、300 次/分钟，只拦明显的机器流量。
 *
 * 放在模块作用域而不是 createApp 里，是因为每个测试都会 createApp 一次，
 * 各自建一份计数器会让「同一个测试进程里的 429」变得不可预测。
 * 计数按 IP 分组，跨 app 实例共用同一个 store 也不会串号。
 */
const globalLimiter = createGlobalLimiter()

/**
 * 组装 Express 应用（不监听端口）。
 * 拆成工厂函数是为了测试里能直接 supertest(createApp())，不用起真实端口。
 */
export function createApp() {
  const app = express()

  app.disable('x-powered-by')

  // 反代后面必须配置，否则 req.ip 全是反代地址，网络指纹退化成全站一个桶
  // （md/35 §3.4）。默认 false，与 Express 行为一致
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy)

  // 顺序不能变：helmet → cors → 日志 → json → 路由 → 404 → errorHandler
  //
  // 日志必须排在 express.json **之前**：请求体过大（413）或不是合法 JSON（400）
  // 都是在 json 中间件里抛的，那时如果还没走到 requestLogger，req.id 就不存在，
  // 这两种错误响应带不上 requestId，访问日志也漏掉它们（md/45 L4）。
  app.use(helmet())
  app.use(
    cors({
      // 白名单判定。三种情况：
      //   没有 Origin（curl / 服务端调用）→ 放行，CORS 只约束浏览器
      //   在 CLIENT_ORIGIN 列表里          → 放行
      //   其它                             → 不回 Access-Control-Allow-Origin
      // 第三种**不要抛错**：抛错会落到 errorHandler 变成 500，
      // 而正确行为就是「响应正常返回，浏览器自己拦下」
      origin: (origin, callback) => {
        if (!origin) return callback(null, true)
        const allowed = config.clientOrigins.includes(origin.replace(/\/+$/, ''))
        callback(null, allowed)
      },
      credentials: false,
    }),
  )
  // 请求日志：一个请求一行可读文本，同时提供 req.id / req.log（md/13 C3）。
  // 替换 pino-http 的原因是它默认打整个 req / res 的 JSON，终端里看不出前端调了什么。
  app.use(requestLogger)
  // 访问日志落库（md/53）：终端日志重启即丢，这里按 IP / 用户 / 路径可回查
  app.use(accessLogger)

  // 全局兜底限流（md/45 M5）：放在 json 解析之前——被拦的请求既不解析 body、
  // 也不查会话，代价只有一次内存计数。放在日志之后是为了 429 也带 req.id 并进访问日志
  app.use(globalLimiter)

  // 放在日志之后：解析失败时 req.id 已经存在，400/413 才能带上 requestId
  app.use(express.json({ limit: '64kb' }))

  // 解析令牌 → req.userId（md/33 §7.1）。只解析不拦截，见 currentUser.js
  app.use(currentUser)

  // 路由挂载区（后续步骤往里加）
  // 公开：健康检查与词典是静态数据，验证码/登录必须在没有身份时也能调
  app.use('/api', healthRoutes)
  app.use('/api/auth', authRoutes)
  app.use('/api/dictionary', dictionaryRoutes)
  // 基础词汇库的游客只读视图（md/50）：静态词表，不查库、不看令牌
  app.use('/api/public/basic-words', publicBasicWordRoutes)
  // 额度查询必须匿名可调：未登录也要知道这台设备今天还剩几次（md/35 §7.1）
  app.use('/api/quota', quotaRoutes)

  // 个人中心必须是真的登录了（不是 req.userId 回落出来的 local-user），
  // 所以两道都挂：requireAuth 管开关打开后的统一 401，requireSession 管开关没开时的漏网
  app.use('/api/profile', requireAuth, requireSession, profileRoutes)

  // 需要身份。AUTH_ENFORCED=false 时 currentUser 会把 req.userId 回落成 DEFAULT_USER_ID，
  // 所以这三个 requireAuth 现在等于放行——打开开关才开始真正 401（md/33 §7.3）
  app.use('/api/words', requireAuth, wordRoutes)
  app.use('/api/word-banks', requireAuth, wordBankRoutes)
  app.use('/api/basic-words', requireAuth, basicWordRoutes)
  app.use('/api/readings', requireAuth, readingRoutes)

  // 用户侧反馈：**不挂 requireAuth**（md/37 §5.1）。
  // 「在登录页卡住了」是最常见的反馈场景，要求登录等于把这类反馈关掉
  app.use('/api/feedback', feedbackRoutes)

  // 管理端：两项 env 都配置了才挂载，否则整个前缀 404（md/37 §2.1）。
  // 不做「启动了但登录时再报错」——少一个未鉴权接口暴露在外面
  if (isAdminConfigured()) app.use('/api/admin', adminRoutes)

  // 404 兜底：Express 5 里 app.use('*', ...) 已失效，直接写无路径中间件。
  // 这里的 NOT_FOUND 只表示"没有这个路由"，不属于 §4.7 的业务错误码。
  app.use((req, res) => {
    // 与 4xx/5xx 一样带 requestId：前端 ServerError 读的就是这个字段，
    // 没有它时「接口不存在」这类报障无法对上日志（md/45 L4）
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: '接口不存在' },
      requestId: req.id,
    })
  })

  app.use(errorHandler)

  return app
}
