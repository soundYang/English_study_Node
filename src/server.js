import mongoose from 'mongoose'

import { createApp } from './app.js'
import { config } from './config/index.js'
import { logger } from './shared/logger.js'

async function main() {
  const app = createApp()

  // 顺序：连库 → 载词库（S5）→ listen。
  // 反过来的话，启动瞬间进来的请求会打到半初始化状态。
  await mongoose.connect(config.mongodbUri)
  logger.info(`mongo connected: ${mongoose.connection.name}`)

  const server = app.listen(config.port, () => {
    logger.info(`api listening on http://localhost:${config.port}`)
  })

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭`)
    await new Promise((resolve) => server.close(resolve))
    await mongoose.disconnect()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error({ err }, '启动失败')
  process.exit(1)
})
