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
// 放行生词的额度同理：.env 里调成 3 时，「6 个生词应被拦下」的断言会变成 201
process.env.MAX_UNKNOWN_WORDS = '5'
process.env.MAX_OUTPUT_TOKENS = '8192'

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
