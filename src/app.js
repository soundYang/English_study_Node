import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import pinoHttp from 'pino-http'

import { config } from './config/index.js'
import dictionaryRoutes from './modules/dictionary/dictionary.routes.js'
import healthRoutes from './modules/health/health.routes.js'
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

  // MVP 无登录：所有请求归属 DEFAULT_USER_ID，下游一律读 req.userId
  app.use(currentUser)

  // 路由挂载区（后续步骤往里加）
  app.use('/api', healthRoutes)
  app.use('/api/words', wordRoutes)
  app.use('/api/dictionary', dictionaryRoutes)

  // 404 兜底：Express 5 里 app.use('*', ...) 已失效，直接写无路径中间件。
  // 这里的 NOT_FOUND 只表示"没有这个路由"，不属于 §4.7 的业务错误码。
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } })
  })

  app.use(errorHandler)

  return app
}
