#!/usr/bin/env node
/**
 * 用一份候选基础词表复算历史样本的用词违规（方案 §4.2 预演）
 *
 * 目的：扩词表要花真金白银重跑采样（§12.3 要求同一套 fixture 对比），
 * 先在这里用**零成本**的方式估一下：把历史失败样本的最后一轮正文，分别用
 * 「当前词表」和「候选词表」判一遍，看有多少条会从 422 变成 201。
 *
 * 局限（读数时必须记住）：
 *   · `GenerationFailure` 没存模型声明的 `names`，这里用「句中首字母大写」猜名字，
 *     猜多了会少算违规——所以这是**乐观估计**，真实结果只会更差
 *   · `finalArticle` 落库时截到 8000 字符，超长文章可能少算尾部
 *
 * 用法：
 *   node scripts/extend-basic-words.mjs --out samples/basic-words.next.json   # 先生成候选
 *   node scripts/replay-violations.mjs --basic samples/basic-words.next.json
 *
 * ⚠️ 只读数据库。不写库、不调模型、不产生费用。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { ABBREVIATION_WORDS } from '../src/modules/readings/abbreviations.js'
import { calendarWords } from '../src/modules/readings/calendar-words.js'
import { basicWordsByLevel } from '../src/modules/readings/basic-words.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { validateArticle } from '../src/modules/readings/vocabulary.service.js'
import { Word } from '../src/modules/words/word.model.js'

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const BASIC_FILE = resolve(argValue('basic', 'data/basic-words.hard.json'))
const since = argValue('since') ? new Date(`${argValue('since')}T00:00:00`) : null
const userArg = argValue('user')

function loadBasic(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 猜模型声明过的名字：句子里的首字母大写词（句首不算）。
 * 失败样本没存 names，不猜的话每个名字都会被算成 proper_noun，直接高估违规。
 */
function guessNames(article) {
  const names = new Set()

  for (const sentence of String(article).split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.match(/[A-Za-z][A-Za-z']*/g) ?? []
    for (const token of tokens.slice(1)) {
      if (/^[A-Z]/.test(token) && token.length > 1) names.add(token.toLowerCase())
    }
  }

  return [...names]
}

async function allowedWordsFor(userId, basics) {
  const words = await Word.find({ userId, status: { $in: ['learning', 'mastered'] } })
    .select('word')
    .lean()

  return new Set([
    ...words.map((item) => item.word),
    ...basics,
    ...calendarWords,
    ...ABBREVIATION_WORDS,
  ])
}

const countOf = (result) => result.unknownWords.length
const missingCommon = (result) => result.counts.missing_common ?? 0

async function main() {
  // 分档之后「当前词表」随样本难度变化：easy 样本按 easy 档复算，
  // 拿 hard 的 2578 词当基线会让所有样本都显得没问题
  const currentBasicsFor = (level) => basicWordsByLevel[level] ?? basicWordsByLevel.hard
  const candidateBasics = loadBasic(BASIC_FILE)

  console.log(
    `\n当前基础词 easy/medium/hard = ${Object.values(basicWordsByLevel).map((list) => list.length).join('/')}`
      + `｜候选 ${candidateBasics.length}｜maxUnknownWords=${config.maxUnknownWords}\n`,
  )

  await mongoose.connect(config.mongodbUri)

  try {
    const filter = {
      errorCode: 'VOCABULARY_VALIDATION_FAILED',
      ...(userArg ? { userId: userArg } : { userId: { $regex: '^fixture-' } }),
    }
    if (since) filter.createdAt = { $gte: since }

    const failures = await GenerationFailure.find(filter).sort({ createdAt: 1 }).lean()
    console.log(`失败样本 ${failures.length} 条（VOCABULARY_VALIDATION_FAILED）\n`)

    if (failures.length === 0) return

    const allowedCache = new Map()
    const rows = []

    for (const doc of failures) {
      const currentBasics = currentBasicsFor(doc.level)
      const [currentAllowed, candidateAllowed] = await Promise.all([
        allowedCache.get(`cur:${doc.userId}:${doc.level}`)
          ?? allowedWordsFor(doc.userId, currentBasics),
        allowedCache.get(`new:${doc.userId}:${doc.level}`)
          ?? allowedWordsFor(doc.userId, candidateBasics),
      ])
      allowedCache.set(`cur:${doc.userId}:${doc.level}`, currentAllowed)
      allowedCache.set(`new:${doc.userId}:${doc.level}`, candidateAllowed)

      const names = guessNames(doc.finalArticle)
      const replayCurrent = validateArticle({
        article: doc.finalArticle,
        allowedWords: currentAllowed,
        names,
      })
      const replayCandidate = validateArticle({
        article: doc.finalArticle,
        allowedWords: candidateAllowed,
        names,
      })

      rows.push({
        level: doc.level,
        targetWords: doc.targetWords,
        stored: (doc.finalUnknownWords ?? []).length,
        current: countOf(replayCurrent),
        candidate: countOf(replayCandidate),
        currentMissing: missingCommon(replayCurrent),
        candidateMissing: missingCommon(replayCandidate),
        wouldPass: countOf(replayCandidate) <= config.maxUnknownWords,
        words: replayCandidate.unknownWords.slice(0, 5).join('、'),
      })
    }

    console.log('| 难度/篇幅 | 库里的违规数 | 当前词表复算 | 新词表复算 | 超额度？ | 补词表后仍违规的前 5 词 |')
    console.log('|---|---|---|---|---|---|')
    for (const row of rows) {
      console.log(
        `| ${row.level}/${row.targetWords} | ${row.stored} | ${row.current} | ${row.candidate} |` +
          ` ${row.candidate > config.maxUnknownWords ? '是' : '**否**'} | ${row.words || '—'} |`,
      )
    }

    const passed = rows.filter((row) => row.wouldPass)
    const total = (key) => rows.reduce((sum, row) => sum + row[key], 0)

    console.log('\n汇总')
    console.log(
      `  违规数（当前 → 候选）：${total('current')} → ${total('candidate')}` +
        `（-${((1 - total('candidate') / Math.max(1, total('current'))) * 100).toFixed(1)}%）`,
    )
    console.log(
      `  missing_common（当前 → 候选）：${total('currentMissing')} → ${total('candidateMissing')}`,
    )
    console.log(`  会从 422 变 201 的：${passed.length}/${rows.length} 条`)
    console.log('  注：名字是按句中大写猜的，属于乐观估计；真实结果只会更差。')

    // 成功样本不该受影响：放宽词表只会减少违规，这里只确认没有反例
    const readings = await Reading.find({
      ...(userArg ? { userId: userArg } : { userId: { $regex: '^fixture-' } }),
      ...(since ? { createdAt: { $gte: since } } : {}),
    })
      .select('userId level targetWords article aiMeta.violationsCount')
      .lean()

    // 扩表只会减少违规。比较对象必须是「同一口径下的两遍复算」——
    // 库里存下来的 violationsCount 对超长样本是假的 0（§6.8），不能拿来当基线
    let increased = 0
    for (const doc of readings) {
      const allowedCurrent =
        allowedCache.get(`cur:${doc.userId}:${doc.level}`)
        ?? (await allowedWordsFor(doc.userId, currentBasicsFor(doc.level)))
      const allowedCandidate =
        allowedCache.get(`new:${doc.userId}:${doc.level}`)
        ?? (await allowedWordsFor(doc.userId, candidateBasics))
      allowedCache.set(`cur:${doc.userId}:${doc.level}`, allowedCurrent)
      allowedCache.set(`new:${doc.userId}:${doc.level}`, allowedCandidate)

      const names = guessNames(doc.article)
      const current = validateArticle({
        article: doc.article,
        allowedWords: allowedCurrent,
        names,
      })
      const candidate = validateArticle({
        article: doc.article,
        allowedWords: allowedCandidate,
        names,
      })

      if (candidate.unknownWords.length > current.unknownWords.length) increased += 1
    }

    console.log(
      `  成功样本 ${readings.length} 条：扩表后违规数反而变多的 ${increased} 条` +
        '（应为 0；非 0 说明复算口径有问题）',
    )
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(async (error) => {
  console.error('[replay-violations] 失败：', error.message)
  process.exitCode = 1
  await mongoose.disconnect().catch(() => {})
})
