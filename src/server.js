import mongoose from 'mongoose'

import { createApp } from './app.js'
import { config } from './config/index.js'
import { AdminAudit } from './modules/admin/admin-audit.model.js'
import { AdminSession } from './modules/admin/admin.model.js'
import { UserApiKey } from './modules/ai-keys/ai-key.model.js'
import { AppMeta } from './modules/auth/appmeta.model.js'
import { Captcha } from './modules/auth/captcha.model.js'
import { Session } from './modules/auth/session.model.js'
import { User } from './modules/auth/user.model.js'
import { loadDictionary } from './modules/dictionary/dictionary.loader.js'
import { Feedback } from './modules/feedback/feedback.model.js'
import { AccessLog } from './modules/logs/access-log.model.js'
import { ErrorLog } from './modules/logs/error-log.model.js'
import { LoginRecord } from './modules/logs/login-log.model.js'
import { Quota } from './modules/quota/quota.model.js'
import { basicWordsByLevel } from './modules/readings/basic-words.js'
import { GenerationTask } from './modules/readings/generation-task.model.js'
import {
  reclaimInterruptedTasks,
  startGenerationScheduler,
  startTaskSweeper,
  stopGenerationScheduler,
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
    // 管理端审计表的 TTL 是「看过谁的手机号」只留 90 天而不是永久堆积的唯一保证
    AdminAudit.syncIndexes(),
    Feedback.syncIndexes(),
    // token 流水是只追加的账本，只是性能索引，但漏建会让台账页随数据量变慢
    TokenUsage.syncIndexes(),
    // 自备 Key 的去重靠 { userId, provider } 唯一索引（md/43 §4.4）；
    // 漏建时并发 PUT 会留下两条，解密时取哪条都不对
    UserApiKey.syncIndexes(),
    // 日志表的 TTL 索引是「不会无限增长」的唯一保证（md/53 §4）；
    // 漏建时表会一直长，最后撑爆磁盘
    AccessLog.syncIndexes(),
    ErrorLog.syncIndexes(),
    LoginRecord.syncIndexes(),
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

  // 安全开关自检（md/45 H2）：照抄 .env.example 部署时这里就是 false，
  // 此时所有匿名请求都归到 DEFAULT_USER_ID，全站共用一份词库、文章和额度，
  // 而且不会以任何报错的形式暴露。不硬拒启动是因为本地开发离不开这个模式，
  // 但必须让它在日志第一屏就显眼——上线时 grep 一条 AUTH_ENFORCED 就能发现。
  if (!config.authEnforced) {
    logger.warn(
      `AUTH_ENFORCED=false：匿名请求将全部归到 ${config.defaultUserId}，全站共用一个数据域。仅限本地开发，生产必须设 true`,
    )
  }

  // legacy 接管白名单（md/45 M1）：没配 = 谁都不接管，历史数据留在 DEFAULT_USER_ID 名下。
  // 这条 warn 只在没配的时候打，因为只有这种情况需要人做决定：
  // 要么确认没有历史数据，要么配上站主用户名，要么接受它不再可达。
  if (config.legacyClaimUsers.length === 0) {
    logger.warn(
      `LEGACY_CLAIM_USER 未配置：不会有账号自动接管 ${config.defaultUserId} 的历史数据。若库里有登录体系之前的数据需要保留，配置该变量后再注册对应用户`,
    )
  }

  // 队列心跳必须在开始接任务之前启动，否则正常排队的任务会被巡检误杀
  startGenerationScheduler()

  const server = app.listen(config.port, () => {
    logger.info(`api listening on http://localhost:${config.port}`)
  })

  // HTTP 超时（md/45 L6）。Node 默认 requestTimeout=300s、headersTimeout=60s，
  // 一个慢速客户端就能把连接挂五分多钟；反代后面这些默认值还和 nginx 对不上：
  //   · requestTimeout  整个请求（含 body）的硬上限。没有哪个接口该跑两分钟——
  //     文章生成是后台任务，请求只负责入队；上传也远小于这个数
  //   · headersTimeout  只等请求头。必须 > keepAliveTimeout，否则 Node 会拒绝启动
  //   · keepAliveTimeout 空闲长连接。要比反代侧的 idle 超时（nginx 默认 60s）
  //     略长，短了会出现「代理复用了一条 Node 已经关掉的连接」→ 偶发 502
  server.requestTimeout = 120_000
  server.headersTimeout = 66_000
  server.keepAliveTimeout = 65_000

  // 周期回收失联实例的任务：kill -9 / OOM 不会走任何清理逻辑
  const stopTaskSweeper = startTaskSweeper()

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭`)
    stopGenerationScheduler()
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
