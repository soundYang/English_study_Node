import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { afterAll, afterEach, beforeAll } from 'vitest'

/**
 * 测试环境全局准备。
 *
 * 这几行必须在任何业务模块被导入之前执行：
 * config/index.js 在模块加载时就会校验 MONGODB_URI，缺了会直接 exit(1)。
 * setupFiles 先于测试文件求值，所以写在这里是安全的。
 */
process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/unused'

// 配置会被 dotenv 从本地 .env 读进来，测试不能跟着开发机上的值跑：
// 断言「修正两轮」的用例在 MAX_REPAIR_ROUNDS=1 的机器上会莫名其妙变红。
process.env.MAX_REPAIR_ROUNDS = '2'
// 篇幅压缩有独立额度；调成 0 会让「超长应触发压缩轮」的用例退化成一次调用
process.env.MAX_LENGTH_ROUNDS = '1'
// 生词预算按难度取（easy 0 / medium 3 / hard 5），不再是全局数字。
// 这里显式留空而不删除：dotenv 不会覆盖已存在的变量，留空能挡住开发机 .env
// 里的 MAX_UNKNOWN_WORDS（那会变成全局覆盖，把三档压成同一个数，W3 的断言全失效）。
process.env.MAX_UNKNOWN_WORDS = ''
process.env.MAX_OUTPUT_TOKENS = '8192'

// 绝大多数用例测的是整篇路径的行为（修正轮、结构错误、失败样本），
// 打桩也只认识「一次返回整篇文章」的形状。生产默认是 segmented，
// 分段路径由 segmented.test.js 用 vi.mock 单独把策略调成 segmented。
process.env.GENERATION_STRATEGY = 'whole'
// 分段路径的参数也固定下来，避免开发机 .env 改写并发/重试次数
process.env.SEGMENT_CONCURRENCY = '4'
process.env.SEGMENT_MAX_ATTEMPTS = '2'
process.env.SEGMENT_TEMPERATURE = '0.5'

const { loadDictionary } = await import('../modules/dictionary/dictionary.loader.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

let mongod

beforeAll(async () => {
  // 词库是进程级只读数据，每个测试文件加载一次即可（约 2.2MB，<100ms）
  loadDictionary()

  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri('word_reading_test'))
  // 唯一索引是「重复返回 409」的最终保险，测试里也必须真的建出来
  await Promise.all([Word.syncIndexes(), Reading.syncIndexes()])
})

afterEach(async () => {
  const { collections } = mongoose.connection
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({})),
  )
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongod?.stop()
})
