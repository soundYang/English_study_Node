/**
 * 真实模型冒烟测试：8,000 词个人词库 + 一次完整生成（md/63 §4.13.3 待补测项）。
 *
 * 与性能脚本的区别：
 *   · 本脚本会真实调用 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL，产生费用；
 *   · 生成链路走 `generateReading`，包含提示词、JSON 校验、修正轮；
 *   · 仍然只连 mongodb-memory-server，不碰 3000 端口和真实数据库。
 *
 * 运行：node scripts/smoke-real-generation-8000.mjs
 * 可选：TARGET_WORDS=100 LEVEL=easy node scripts/smoke-real-generation-8000.mjs
 */

import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused'
process.env.RATE_LIMIT_ENABLED = 'false'
process.env.AUTH_ENFORCED = 'false'
process.env.DAILY_QUOTA_ENABLED = 'false'
process.env.TOKEN_BUDGET_ENABLED = 'false'
process.env.USER_API_KEY_ENABLED = 'false'
process.env.WORD_LIBRARY_LIMIT = '8000'
// 测试实例不与本机服务共用任务调度器
process.env.GENERATION_MAX_ACTIVE = '0'
process.env.GENERATION_MAX_QUEUE = '0'

const TARGET_WORDS = Number(process.env.TARGET_WORDS ?? 100)
const LEVEL = process.env.LEVEL ?? 'easy'
const USER_ID = 'fixture-real-8000'
const LIBRARY_SIZE = 8000

const { config } = await import('../src/config/index.js')
const { generateReading } = await import(
  '../src/modules/readings/reading.service.js'
)
const { loadDictionary } = await import(
  '../src/modules/dictionary/dictionary.loader.js'
)
const { Word } = await import('../src/modules/words/word.model.js')
const { buildCreatePayload } = await import('../src/modules/words/word-import.js')
const { wordRanks } = await import('../src/modules/words/word-ranks.js')

function fail(message) {
  throw new Error(message)
}

async function seedLibrary() {
  const entries = [...wordRanks.entries()].sort((a, b) => a[1] - b[1])
  const docs = []
  const skipped = []

  for (const [word] of entries) {
    if (docs.length >= LIBRARY_SIZE) break

    try {
      docs.push(
        buildCreatePayload({
          userId: USER_ID,
          word,
          status: 'learning',
          source: 'dictionary',
        }),
      )
    } catch {
      // 排名表里可能有词典未收录的词，跳过而不是让整个种子失败
      skipped.push(word)
    }
  }

  if (docs.length < LIBRARY_SIZE) {
    fail(`只种出 ${docs.length} 个词，少于 ${LIBRARY_SIZE}`)
  }

  await Word.insertMany(docs, { ordered: false })

  return { seeded: docs.length, skipped: skipped.length }
}

function report(dto, durationMs) {
  const promptTokens = dto.tokenUsage?.promptTokens ?? 0
  const completionTokens = dto.tokenUsage?.completionTokens ?? 0
  const totalTokens = dto.tokenUsage?.totalTokens ?? 0

  console.log('--- 生成结果 ---')
  console.log(`level/target:      ${dto.level} / ${dto.targetWords}`)
  console.log(`标题:              ${dto.title}`)
  console.log(`正文实际词数:      ${dto.actualWords}`)
  console.log(`题目数:            ${dto.questions.length}`)
  console.log(`usedWords:         ${dto.usedWords.length}`)
  console.log(`newWords（生词）:  ${dto.newWords.length}`)
  console.log(`token:             prompt=${promptTokens} completion=${completionTokens} total=${totalTokens}`)
  console.log(`耗时:              ${(durationMs / 1000).toFixed(1)}s`)
  console.log('--- 正文 ---')
  console.log(dto.article)

  if (!dto.article || !dto.title) fail('返回缺少标题或正文')
  if (dto.questions.length !== 5) fail(`题目数应为 5，实际 ${dto.questions.length}`)
  if (dto.actualWords < TARGET_WORDS * 0.85) {
    fail(`正文只有 ${dto.actualWords} 词，低于验收下限 ${Math.floor(TARGET_WORDS * 0.85)}`)
  }
  if (totalTokens <= 0) fail('tokenUsage 为 0，无法确认上游真实调用')
  if (LEVEL === 'easy' && dto.newWords.length > 0) {
    fail(`easy 不应出现生词，实际 ${dto.newWords.length} 个`)
  }
}

async function main() {
  console.log(`model:   ${config.deepseekModel}`)
  console.log(`strategy:${config.generationStrategy}`)
  console.log(`fixture: ${USER_ID}，个人词库 ${LIBRARY_SIZE}`)

  const mongod = await MongoMemoryServer.create()

  try {
    await mongoose.connect(mongod.getUri('real_generation_smoke'))
    await Word.syncIndexes()
    loadDictionary()

    const seed = await seedLibrary()
    console.log(`seeded:  ${seed.seeded} 词（跳过词典未收录 ${seed.skipped} 个）`)

    const start = Date.now()
    const dto = await generateReading({
      userId: USER_ID,
      body: {
        level: LEVEL,
        targetWords: TARGET_WORDS,
        questionCount: 5,
        vocabScope: ['all'],
      },
    })
    const durationMs = Date.now() - start

    report(dto, durationMs)
    console.log('\n真实模型调用通过')
  } finally {
    await mongoose.disconnect().catch(() => {})
    await mongod.stop()
  }
}

main().catch((error) => {
  console.error('\n真实模型调用失败：')
  console.error(error?.message || error)
  if (error?.details) console.error(JSON.stringify(error.details, null, 2))
  process.exitCode = 1
})
