import mongoose from 'mongoose'

import { createApp } from './app.js'
import { config } from './config/index.js'
import { AdminSession } from './modules/admin/admin.model.js'
import { AppMeta } from './modules/auth/appmeta.model.js'
import { Captcha } from './modules/auth/captcha.model.js'
import { Session } from './modules/auth/session.model.js'
import { User } from './modules/auth/user.model.js'
import { loadDictionary } from './modules/dictionary/dictionary.loader.js'
import { Feedback } from './modules/feedback/feedback.model.js'
import { Quota } from './modules/quota/quota.model.js'
import { basicWordsByLevel } from './modules/readings/basic-words.js'
import { GenerationTask } from './modules/readings/generation-task.model.js'
import {
  reclaimInterruptedTasks,
  startTaskSweeper,
} from './modules/readings/generation-task.service.js'
import { Reading } from './modules/readings/reading.model.js'
import { basicWordsVersions } from './modules/readings/versions.js'
import { TokenUsage } from './modules/usage/token-usage.model.js'
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
  //
  // users 尤其关键：注册**不做**「先查再建」，重名完全靠 usernameLower 唯一索引兜住。
  // 索引漏建的话，同名的第二个用户会直接建成功，而应用层不会有任何报错。
  await Promise.all([
    Word.syncIndexes(),
    Reading.syncIndexes(),
    GenerationTask.syncIndexes(),
    User.syncIndexes(),
    Session.syncIndexes(),
    Captcha.syncIndexes(),
    AppMeta.syncIndexes(),
    // { key, day } 唯一索引是额度预扣的原子性来源：漏建的话并发预扣会多放人
    Quota.syncIndexes(),
    // 管理端会话靠 tokenHash 唯一索引与过期 TTL；反馈靠状态/设备索引
    AdminSession.syncIndexes(),
    Feedback.syncIndexes(),
    // token 流水是只追加的账本，只是性能索引，但漏建会让台账页随数据量变慢
    TokenUsage.syncIndexes(),
  ])
  logger.info('indexes synced')

  // 任务执行器在进程内：失联实例留下的 queued / running 不会再有人推进，
  // 留着只会让前端轮询到一个永远不动的进度条（md/31 §11）。
  // 判据是心跳过期，不是「谁在启动」——多实例下不能误杀别人正在跑的任务
  await reclaimInterruptedTasks()

  // 词库必须在 listen 之前加载完，否则第一个进单词页的用户会遇到空词库
  const stats = loadDictionary()
  logger.info(
    `dictionary loaded: ${stats.searchable} words (filtered ${stats.filtered} of ${stats.rawTotal})`,
  )
  // 基础词表是「校验放行」的白名单，不是提示词装饰：文件被换掉/读不到时，
  // 光看日志就能发现，不用等一次 422 才反应过来（§4.2.4）。
  // 分档之后三档各打一行——只打合计会掩盖「medium 读不到、悄悄降成 easy」。
  for (const [level, list] of Object.entries(basicWordsByLevel)) {
    logger.info(`basic words loaded: ${level} ${list.length} (version ${basicWordsVersions[level]})`)
  }

  const server = app.listen(config.port, () => {
    logger.info(`api listening on http://localhost:${config.port}`)
  })

  // 周期回收失联实例的任务：kill -9 / OOM 不会走任何清理逻辑
  const stopTaskSweeper = startTaskSweeper()

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭`)
    stopTaskSweeper()
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
