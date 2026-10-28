import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import pinoHttp from 'pino-http'

import { config } from './config/index.js'
import authRoutes from './modules/auth/auth.routes.js'
import { requireAuth, requireSession } from './modules/auth/auth.middleware.js'
import profileRoutes from './modules/auth/profile.routes.js'
import basicWordRoutes from './modules/basic-words/basic-words.routes.js'
import dictionaryRoutes from './modules/dictionary/dictionary.routes.js'
import healthRoutes from './modules/health/health.routes.js'
import readingRoutes from './modules/readings/reading.routes.js'
import wordRoutes from './modules/words/word.routes.js'
import { ERROR_CODES } from './shared/errors.js'
import { logger } from './shared/logger.js'
import { currentUser } from './shared/middleware/currentUser.js'
import { errorHandler } from './shared/middleware/errorHandler.js'

/**
 * 组装 Express 应用（不监听端口）。
 * 拆成工厂函数是为了测试里能直接 supertest(createApp())，不用起真实端口。
 */
export function createApp() {
  const app = express()

  app.disable('x-powered-by')

  // 顺序不能变：helmet → cors → json → 日志 → 路由 → 404 → errorHandler
  app.use(helmet())
  app.use(cors({ origin: config.clientOrigin, credentials: false }))
  app.use(express.json({ limit: '64kb' }))

  // pino-http 自带 req.log 和 req.id，不再另写 requestId 中间件（两套会打架）
  app.use(
    pinoHttp({
      logger,
      // 健康检查会被探活工具高频调用，日志里全是它没有价值
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error'
        if (res.statusCode >= 400) return 'warn'
        return 'info'
      },
    }),
  )

  // 解析令牌 → req.userId（md/33 §7.1）。只解析不拦截，见 currentUser.js
  app.use(currentUser)

  // 路由挂载区（后续步骤往里加）
  // 公开：健康检查与词典是静态数据，验证码/登录必须在没有身份时也能调
  app.use('/api', healthRoutes)
  app.use('/api/auth', authRoutes)
  app.use('/api/dictionary', dictionaryRoutes)

  // 个人中心必须是真的登录了（不是 req.userId 回落出来的 local-user），
  // 所以两道都挂：requireAuth 管开关打开后的统一 401，requireSession 管开关没开时的漏网
  app.use('/api/profile', requireAuth, requireSession, profileRoutes)

  // 需要身份。AUTH_ENFORCED=false 时 currentUser 会把 req.userId 回落成 DEFAULT_USER_ID，
  // 所以这三个 requireAuth 现在等于放行——打开开关才开始真正 401（md/33 §7.3）
  app.use('/api/words', requireAuth, wordRoutes)
  app.use('/api/basic-words', requireAuth, basicWordRoutes)
  app.use('/api/readings', requireAuth, readingRoutes)

  // 404 兜底：Express 5 里 app.use('*', ...) 已失效，直接写无路径中间件。
  // 这里的 NOT_FOUND 只表示"没有这个路由"，不属于 §4.7 的业务错误码。
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } })
  })

  app.use(errorHandler)

  return app
}
