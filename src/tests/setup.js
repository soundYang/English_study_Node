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

const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

let mongod

beforeAll(async () => {
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
