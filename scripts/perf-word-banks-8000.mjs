/**
 * 8,000 词库性能测试（md/63 §4.13.3）。
 *
 * 只连 mongodb-memory-server，不碰本地 3000 服务和真实数据库。
 * 覆盖列表、词库概要与重置；生成链路需要上游模型，不在本脚本里跑。
 *
 * 运行：node scripts/perf-word-banks-8000.mjs
 */

import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import request from 'supertest'

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused'
process.env.RATE_LIMIT_ENABLED = 'false'
process.env.AUTH_ENFORCED = 'false'
process.env.WORD_LIBRARY_LIMIT = '8000'
process.env.USER_API_KEY_ENABLED = 'false'
process.env.TOKEN_BUDGET_ENABLED = 'false'
process.env.DAILY_QUOTA_ENABLED = 'false'

const { createApp } = await import('../src/app.js')
const { config } = await import('../src/config/index.js')
const { loadDictionary } = await import(
  '../src/modules/dictionary/dictionary.loader.js'
)
const { WordBankMembership } = await import(
  '../src/modules/word-banks/word-bank-membership.model.js'
)
const { getWordBankCatalog } = await import(
  '../src/modules/word-banks/word-banks.catalog.js'
)
const { Word } = await import('../src/modules/words/word.model.js')

const USER_ID = config.defaultUserId
const CUSTOM_COUNT = 1704

function letters(index) {
  let value = index
  let result = ''
  do {
    result = String.fromCharCode(97 + (value % 26)) + result
    value = Math.floor(value / 26)
  } while (value > 0)
  return `perf${result}`
}

async function seed() {
  const catalog = getWordBankCatalog()
  const words = []
  const memberships = []
  const now = new Date()

  for (const [bank, rows] of Object.entries(catalog)) {
    for (const item of rows) {
      words.push({
        userId: USER_ID,
        word: item.word,
        status: 'learning',
        source: 'manual',
        senses: [],
      })
      memberships.push({
        userId: USER_ID,
        word: item.word,
        bank,
        importedAt: now,
        addedBy: 'bulk',
      })
    }
  }

  for (let i = 0; i < CUSTOM_COUNT; i += 1) {
    words.push({
      userId: USER_ID,
      word: letters(i),
      status: 'learning',
      source: 'manual',
      senses: [],
    })
  }

  await Word.insertMany(words)
  await WordBankMembership.insertMany(memberships)
  return words.length
}

async function time(label, requestFactory, { runs = 5, warmup = true } = {}) {
  const samples = []
  let lastStatus = null

  // 首次请求会带上 settle / 索引预热，不计入统计
  if (warmup) await requestFactory()

  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint()
    const res = await requestFactory()
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6
    samples.push(elapsed)
    lastStatus = res.status
  }

  samples.sort((a, b) => a - b)
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]
  const median = samples[Math.floor(samples.length / 2)]

  console.log(
    `${label.padEnd(28)} median=${median.toFixed(0)}ms  p95=${p95.toFixed(0)}ms  max=${samples.at(-1).toFixed(0)}ms  status=${lastStatus}`,
  )
  return { median, p95, max: samples.at(-1) }
}

async function importBank(api, bank) {
  const samples = []
  let cursor = 0
  let done = false
  let created = 0

  while (!done) {
    const start = process.hrtime.bigint()
    const res = await api
      .post(`/api/word-banks/${bank}/add`)
      .send({ all: true, limit: 500, cursor, status: 'learning' })
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)

    if (res.status !== 200) {
      throw new Error(`import ${bank} failed: ${res.status} ${JSON.stringify(res.body)}`)
    }

    created += res.body.created
    cursor = res.body.nextCursor
    done = res.body.done
  }

  samples.sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]

  console.log(
    `POST add ${bank} all`.padEnd(28) +
      `batches=${samples.length}  created=${created}  p95=${p95.toFixed(0)}ms  total=${total.toFixed(0)}ms`,
  )
  return { p95, total }
}

async function main() {
  const mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri('word_bank_perf'))
  await Promise.all([Word.syncIndexes(), WordBankMembership.syncIndexes()])
  loadDictionary()

  const total = await seed()
  console.log(`seeded ${total} words`)

  const app = createApp()
  const api = request(app)

  await time('GET /api/words', () => api.get('/api/words?page=1&pageSize=50'))
  await time('GET /api/word-banks', () => api.get('/api/word-banks'))
  await time('GET high imported', () =>
    api.get('/api/word-banks/high/words?filter=imported&pageSize=50'),
  )

  const highReset = await time(
    'POST reset high',
    () => api.post('/api/word-banks/high/reset').send({ confirm: true }),
    { runs: 1, warmup: false },
  )
  const midReset = await time(
    'POST reset mid',
    () => api.post('/api/word-banks/mid/reset').send({ confirm: true }),
    { runs: 1, warmup: false },
  )

  console.log(
    `reset high: ${highReset.p95.toFixed(0)}ms  reset mid: ${midReset.p95.toFixed(0)}ms`,
  )

  const highImport = await importBank(api, 'high')
  await api.post('/api/word-banks/high/reset').send({ confirm: true })

  const midImport = await importBank(api, 'mid')
  await api.post('/api/word-banks/mid/reset').send({ confirm: true })

  console.log(
    `import high total=${highImport.total.toFixed(0)}ms  import mid total=${midImport.total.toFixed(0)}ms`,
  )

  await mongoose.disconnect()
  await mongod.stop()
}

main().catch(async (error) => {
  console.error(error)
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})
