#!/usr/bin/env node
/**
 * 固定测试集词库 seed（方案 §3.4.2）
 *
 * 为什么需要它：候选池取决于「库里有哪些词、哪些 mastered、哪些超过 7 天没复习、
 * 哪些是今天新增的」。只固定 {level, targetWords}，第二次跑的池子可能完全不同。
 * 所以回归对比的第一步不是跑生成，而是把词库恢复成同一个快照。
 *
 * 用法：
 *   node scripts/seed-test-fixtures.mjs --fixture rich
 *   node scripts/seed-test-fixtures.mjs --fixture thin
 *   node scripts/seed-test-fixtures.mjs --fixture all --anchor 2026-10-28
 *
 * 幂等：先删该 fixture 用户的全部 Word 再插入，重复执行结果一致。
 * 默认同时清掉该用户的 Reading / GenerationFailure，否则上一轮的样本
 * 会和这一轮混在一起（想保留就加 --keep-readings）。
 *
 * ⚠️ 只动 fixture-* 三个用户，永远不碰 local-user。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { basicWords } from '../src/modules/readings/basic-words.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { neededVocabulary, requiredTargetWords } from '../src/modules/readings/vocabulary-pool.js'
import { Word } from '../src/modules/words/word.model.js'
import { wordRanks } from '../src/modules/words/word-ranks.js'

/**
 * 词频区间：太靠前（the / of）没什么可测，太靠后（rank > 6000）连真人都不认识，
 * 会让 hard 档的池子变成一坨生僻词，测出来的是 fixture 而不是产品。
 */
const RANK_MIN = 200
const RANK_MAX = 6000

const FIXTURES = {
  // mixedStatus：只有 learning / mastered 会进候选池，new 不算（word.repository.js）。
  // rich 要测状态混合，所以故意留 20% new；thin 要卡门槛，全部做成入池状态，
  // 否则 120 词里只有 96 个可用，hard 600 词（需 86）只剩 10 个余量
  rich: { userId: 'fixture-rich', count: 900, mixedStatus: true },
  // 120 词已经过不了任何一档的 B 门（easy 也要 1000 个已知词），
  // 只剩「验闸门」这一个用途：每条用例都应当在调模型之前被拦下
  thin: { userId: 'fixture-thin', count: 120, mixedStatus: false },
  // hard 档采样专用（md/21 W3 之后）：B 门要 3778 个已知词 = hard 基础表 2578 +
  // 日历 19 + 至少 1181 个个人词。rich 只有 720 个可用词，永远过不了门，
  // 用它测 hard 等于在测闸门。1800 个全部算已学，留出余量
  full: { userId: 'fixture-full', count: 1800, mixedStatus: false },
}

const DAY_MS = 86_400_000

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

/** 锚点日期：默认今天 09:00（本地时区）。09:00 而不是 00:00，避免跨时区/夏令时把「今天」挪出去 */
function resolveAnchor() {
  const raw = argValue('anchor')
  if (!raw) {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0)
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) {
    throw new Error(`--anchor 格式应为 YYYY-MM-DD，收到：${raw}`)
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9, 0, 0, 0)
}

/**
 * 从 COCA 排名表里等距抽词。
 *
 * 等距而不是随机：随机抽样每次结果不同，回归对比就失去意义；
 * 索引固定，同一个 --fixture 每次拿到的词表逐字相同。
 */
function pickWords(count) {
  const reserved = new Set(basicWords)
  const pool = [...wordRanks.entries()]
    .filter(
      ([word, rank]) =>
        /^[a-z]{3,}$/.test(word) && rank >= RANK_MIN && rank <= RANK_MAX && !reserved.has(word),
    )
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))

  if (pool.length < count) {
    throw new Error(`排名区间内只有 ${pool.length} 个可用词，不够 ${count} 个`)
  }

  const step = pool.length / count

  return Array.from({ length: count }, (_, index) => pool[Math.floor(index * step)])
}

function buildDocs({ userId, count, anchor, mixedStatus }) {
  const words = pickWords(count)

  return words.map(([word, cocaRank], index) => {
    // 状态：10% 已掌握 / 20% 新词 / 70% 学习中（方案写的是 reviewing，Word 里没有这个枚举）
    const bucket = index % 10
    const status = !mixedStatus
      ? bucket === 0
        ? 'mastered'
        : 'learning'
      : bucket === 0
        ? 'mastered'
        : bucket < 3
          ? 'new'
          : 'learning'

    // 复习时间：今天 / 3 天前 / 10 天前。只有 10 天前那批进 P1（≥7 天算久未复习）
    const reviewedDaysAgo = [0, 3, 10][index % 3]

    return {
      userId,
      word,
      status,
      source: 'manual',
      dictionaryId: null,
      phonetic: null,
      senses: [{ pos: '', meaning: 'fixture' }],
      cocaRank,
      lastReviewedAt: new Date(anchor.getTime() - reviewedDaysAgo * DAY_MS),
      // 1/3 的词「今天新增」，给 today_new 用例留出 300 个候选
      createdAt:
        index % 3 === 0 ? anchor : new Date(anchor.getTime() - 30 * DAY_MS),
      updatedAt: anchor,
    }
  })
}

async function seedFixture(name, { anchor, keepReadings }) {
  const fixture = FIXTURES[name]
  if (!fixture) throw new Error(`未知 fixture：${name}`)

  const docs = buildDocs({ ...fixture, anchor })

  // 先删后插：幂等的关键。sorted 之后插入顺序固定，_id 不固定但选池按字段排序，不影响结果
  await Word.deleteMany({ userId: fixture.userId })
  if (!keepReadings) {
    await Reading.deleteMany({ userId: fixture.userId })
    await GenerationFailure.deleteMany({ userId: fixture.userId })
  }

  // timestamps: false 才能用固定 createdAt——否则 mongoose 会覆盖成当前时间，
  // today_new 场景就变成「今天 900 个词全是新词」或跑一天后全部失效
  await Word.insertMany(docs, { timestamps: false })

  const statusCount = docs.reduce((acc, doc) => {
    acc[doc.status] = (acc[doc.status] ?? 0) + 1
    return acc
  }, {})
  const todayNew = docs.filter((doc) => doc.createdAt.getTime() === anchor.getTime()).length
  const todayReviewed = docs.filter(
    (doc) => doc.lastReviewedAt.getTime() === anchor.getTime(),
  ).length
  // 门槛按「能进候选池的词数」算，不是按总词数：new 状态不参与选池
  const eligible = docs.filter((doc) => doc.status !== 'new').length

  console.log(`\n[${name}] userId=${fixture.userId}  共 ${docs.length} 词，其中可入池 ${eligible} 个`)
  console.log(`  状态：${JSON.stringify(statusCount)}`)
  console.log(`  今天新增 ${todayNew} 个，今天复习过 ${todayReviewed} 个`)
  console.log(`  词频区间：${docs[0].cocaRank} – ${docs.at(-1).cocaRank}`)
  console.log('  门槛（neededVocab = ceil(targetWords×0.1 ÷ ratio)）：')

  for (const targetWords of [100, 200, 400, 600]) {
    const cells = ['easy', 'medium', 'hard'].map((level) => {
      const needed = neededVocabulary({ targetWords, level })
      const ok = eligible >= needed
      return `${level} ${String(needed).padStart(3)} ${ok ? '通过' : '422 '}`
    })
    console.log(
      `    ${String(targetWords).padStart(3)} 词（目标词 ${requiredTargetWords(targetWords)}）｜ ${cells.join(' ｜ ')}`,
    )
  }

  return docs.length
}

async function main() {
  const fixtureArg = argValue('fixture', 'all')
  const anchor = resolveAnchor()
  const keepReadings = hasFlag('keep-readings')
  const names = fixtureArg === 'all' ? Object.keys(FIXTURES) : [fixtureArg]

  for (const name of names) {
    if (!FIXTURES[name]) throw new Error(`未知 fixture：${name}（可选 ${Object.keys(FIXTURES).join(' / ')} / all）`)
  }

  console.log(`锚点日期：${anchor.toString()}`)
  console.log(`保留历史 Reading：${keepReadings ? '是' : '否'}`)

  await mongoose.connect(config.mongodbUri)
  console.log(`mongo connected: ${mongoose.connection.name}`)

  try {
    for (const name of names) {
      await seedFixture(name, { anchor, keepReadings })
    }
  } finally {
    await mongoose.disconnect()
  }

  console.log('\n启动测试实例（3000 是用户自己的实例，不要动）：')
  console.log('  DEFAULT_USER_ID=fixture-rich PORT=3100 node src/server.js')
  console.log('  DEFAULT_USER_ID=fixture-thin PORT=3101 node src/server.js')
  console.log('  DEFAULT_USER_ID=fixture-full PORT=3102 node src/server.js')
  console.log('\n注意：today_new / today_reviewed 依赖锚点日期，seed 与 batch 最好同一天跑。')
}

main().catch((error) => {
  console.error('[seed-test-fixtures] 失败：', error.message)
  process.exitCode = 1
})
