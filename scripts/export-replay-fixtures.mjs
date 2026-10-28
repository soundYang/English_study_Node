#!/usr/bin/env node
/**
 * 把本地库里的历史生成结果导出成离线回放夹具（**只读**）。
 *
 * 为什么要有这一步：
 *   现在验证一次改动要真调模型、花 ¥1.7、等几分钟，于是只能攒一批改动一起跑，
 *   攒了就没法归因，归因不了就只能"停下来查"——项目一直在原地打转。
 *   库里已经躺着 41 篇成功正文 + 15 篇失败正文，它们足够把
 *   「校验器、词表、分类、预算」这一层的回归全部离线跑完。
 *
 * 产物：
 *   samples/replay/fixtures.json
 *     · users：每个 fixture 用户的词表（按 status 分组），回放时重建 allowedWords
 *     · cases：每篇正文 + 生成参数 + 当时落库的元数据
 *
 * 注意：这里**不导出** MONGODB_URI，也不打印它。
 *
 * 用法：
 *   node scripts/export-replay-fixtures.mjs
 *   node scripts/export-replay-fixtures.mjs --out samples/replay/fixtures.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = join(ROOT, 'samples', 'replay', 'fixtures.json')

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT }

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i])
  }

  return args
}

/** 失败样本的 finalArticle 可能是 JSON、裸正文或空串，原样导出，由回放侧判定 */
function toFailureCase(doc) {
  return {
    id: `failure:${String(doc._id)}`,
    source: 'failure',
    userId: doc.userId,
    level: doc.level,
    targetWords: doc.targetWords,
    questionCount: doc.questionCount,
    scope: doc.scope ?? [],
    // 原样保留：解析规则放在 replay-core 里，导出侧不替它做决定
    article: String(doc.finalArticle ?? ''),
    names: [],
    stored: {
      errorCode: doc.errorCode ?? null,
      unknownWords: doc.finalUnknownWords ?? [],
      violations: doc.finalViolations ?? [],
      rounds: doc.rounds ?? [],
      repairRounds: doc.repairRounds ?? 0,
      basicWordsVersion: doc.basicWordsVersion ?? null,
      codeVersion: doc.codeVersion ?? null,
      createdAt: doc.createdAt ?? null,
    },
  }
}

function toReadingCase(doc) {
  return {
    id: `reading:${String(doc._id)}`,
    source: 'reading',
    userId: doc.userId,
    level: doc.level,
    targetWords: doc.targetWords,
    questionCount: doc.questionCount,
    scope: doc.targetPlan?.scope ?? [],
    // kind: plain 表示 article 已经是纯正文，不需要再从 JSON 里抠
    kind: 'plain',
    article: String(doc.article ?? ''),
    names: doc.names ?? [],
    title: doc.title,
    translation: doc.translation,
    questions: doc.questions ?? [],
    stored: {
      actualWords: doc.actualWords ?? null,
      violationsCount: doc.aiMeta?.violationsCount ?? null,
      newWords: (doc.newWords ?? []).map((item) => item.word),
      rounds: doc.aiMeta?.rounds ?? [],
      repairRounds: doc.aiMeta?.repairRounds ?? 0,
      basicWordsVersion: doc.aiMeta?.basicWordsVersion ?? null,
      codeVersion: doc.aiMeta?.codeVersion ?? null,
      createdAt: doc.createdAt ?? null,
    },
  }
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2))

  await mongoose.connect(config.mongodbUri)
  const db = mongoose.connection.db

  const [readings, failures, words] = await Promise.all([
    db.collection('readings').find({}).toArray(),
    db.collection('generationfailures').find({}).toArray(),
    db.collection('words').find({}).project({ userId: 1, word: 1, status: 1, cocaRank: 1 }).toArray(),
  ])

  // 词表按用户分组：回放时要用「当时的词库」重建 allowedWords，
  // 不能读当前库——调试期数据随时会变，夹具必须自带上下文。
  const users = {}
  for (const item of words) {
    const bucket = users[item.userId] ?? { learning: [], mastered: [], new: [] }
    const status = ['learning', 'mastered', 'new'].includes(item.status) ? item.status : 'new'
    bucket[status].push(item.word)
    users[item.userId] = bucket
  }

  // 排序固定，保证同一份库导出的文件字节稳定，diff 才有意义
  const cases = [
    ...readings.map(toReadingCase),
    ...failures.map(toFailureCase),
  ].sort((a, b) => a.id.localeCompare(b.id))

  const payload = {
    exportedAt: new Date().toISOString(),
    source: {
      readings: readings.length,
      failures: failures.length,
      users: Object.keys(users).length,
    },
    users,
    cases,
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)

  const empty = cases.filter((item) => !item.article.trim()).length
  console.log(`已导出 ${cases.length} 个样本（成功 ${readings.length} / 失败 ${failures.length}）→ ${out}`)
  console.log(`用户 ${Object.keys(users).length} 个；正文为空的样本 ${empty} 个（回放时跳过）`)

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error('导出失败：', error.message)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
