import mongoose from 'mongoose'

import { createApp } from './app.js'
import { config } from './config/index.js'
import { loadDictionary } from './modules/dictionary/dictionary.loader.js'
import { Reading } from './modules/readings/reading.model.js'
import { Word } from './modules/words/word.model.js'
import { logger } from './shared/logger.js'

async function main() {
  const app = createApp()

  // 顺序：连库 → 载词库（S5）→ listen。
  // 反过来的话，启动瞬间进来的请求会打到半初始化状态。
  await mongoose.connect(config.mongodbUri)
  logger.info(`mongo connected: ${mongoose.connection.name}`)

  // 唯一索引没建上，去重就形同虚设——所以这里故意不 catch，
  // 失败时让 main().catch 打全栈并退出，而不是带着"看起来能跑"的状态启动。
  await Promise.all([Word.syncIndexes(), Reading.syncIndexes()])
  logger.info('indexes synced')

  // 词库必须在 listen 之前加载完，否则第一个进单词页的用户会遇到空词库
  const stats = loadDictionary()
  logger.info(
    `dictionary loaded: ${stats.searchable} words (filtered ${stats.filtered} of ${stats.rawTotal})`,
  )

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
