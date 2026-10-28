#!/usr/bin/env node
/**
 * 补算「修复前超长样本」的用词违规（方案 §6.8）
 *
 * 背景：§6.8 修复前，篇幅额度用尽仍超长的文章不会跑词汇校验，
 * `unknownWords` / `counts` 一律为空。这批存量样本的违规数不可信。
 *
 * 这个脚本只读数据库，用当时的词表口径（用户全部 learning/mastered 词 +
 * 基础词表 + 日历词 + 缩写）重建 allowedWords，在本地补跑 validateArticle，
 * 回答两个问题：
 *   1. 这 N 篇里到底有几篇生词超标——补查有没有意义
 *   2. 如果当初选方案 B（超长即 422），成功率会掉多少
 *
 * 用法：
 *   node scripts/recheck-overlength.mjs                     # 默认 fixture-* 用户
 *   node scripts/recheck-overlength.mjs --user fixture-rich
 *   node scripts/recheck-overlength.mjs --since 2026-10-27
 *
 * ⚠️ 只读。不写库、不调模型、不产生费用。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { ABBREVIATION_WORDS } from '../src/modules/readings/abbreviations.js'
import { basicWords } from '../src/modules/readings/basic-words.js'
import { calendarWords } from '../src/modules/readings/calendar-words.js'
import { unknownBudgetFor } from '../src/modules/readings/level-limits.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { validateArticle } from '../src/modules/readings/vocabulary.service.js'
import { Word } from '../src/modules/words/word.model.js'

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const since = argValue('since') ? new Date(`${argValue('since')}T00:00:00`) : null
const userArg = argValue('user')

/** 和 generateReading 同口径：用户的已学词 + 基础词表 + 日历词 + 缩写 */
async function allowedWordsFor(userId) {
  const words = await Word.find({ userId, status: { $in: ['learning', 'mastered'] } })
    .select('word')
    .lean()

  return new Set([
    ...words.map((item) => item.word),
    ...basicWords,
    ...calendarWords,
    ...ABBREVIATION_WORDS,
  ])
}

/** 修复前「超长且没查过」的样本：最后一轮是 word_count，且没有 counts */
function isBlindSpot(doc) {
  const last = doc.aiMeta?.rounds?.at(-1)
  return Boolean(last && last.feedbackType === 'word_count' && !last.counts)
}

async function main() {
  await mongoose.connect(config.mongodbUri)

  try {
    const filter = userArg ? { userId: userArg } : { userId: { $regex: '^fixture-' } }
    if (since) filter.createdAt = { $gte: since }

    const docs = await Reading.find(filter).sort({ createdAt: 1 }).lean()
    const targets = docs.filter(isBlindSpot)

    console.log(
      `\n扫描 ${docs.length} 篇文章，其中「超长且没查过」${targets.length} 篇` +
        '（生词预算按难度：easy 0 / medium 3 / hard 5）\n',
    )

    if (targets.length === 0) {
      console.log('没有需要补算的样本。')
      return
    }

    const allowedCache = new Map()
    const rows = []

    for (const doc of targets) {
      if (!allowedCache.has(doc.userId)) {
        allowedCache.set(doc.userId, await allowedWordsFor(doc.userId))
      }

      const result = validateArticle({
        article: doc.article,
        allowedWords: allowedCache.get(doc.userId),
        names: doc.names ?? [],
      })

      rows.push({
        id: String(doc._id).slice(-6),
        userId: doc.userId,
        level: doc.level,
        targetWords: doc.targetWords,
        actualWords: doc.actualWords,
        stored: doc.aiMeta.violationsCount ?? 0,
        rechecked: result.unknownWords.length,
        budget: unknownBudgetFor(doc.level),
        over: result.unknownWords.length > unknownBudgetFor(doc.level),
        counts: result.counts,
        sample: result.unknownWords.slice(0, 6).join('、'),
      })
    }

    console.log(
      '| 文章 | 难度 | 篇幅 | 实际词数 | 库里的违规数 | 补算违规数 | 超额度 | 前 6 个词 |',
    )
    console.log('|---|---|---|---|---|---|---|---|')
    for (const row of rows) {
      console.log(
        `| ${row.id} | ${row.level} | ${row.targetWords} | ${row.actualWords} |` +
          ` ${row.stored} | ${row.rechecked} | ${row.over ? '**是**' : '否'} | ${row.sample} |`,
      )
    }

    const over = rows.filter((row) => row.over)
    const total = (key) => rows.reduce((sum, row) => sum + row[key], 0)
    const categorySum = (category) =>
      rows.reduce((sum, row) => sum + (row.counts[category] ?? 0), 0)

    console.log('\n汇总')
    console.log(
      `  补算违规 ${total('rechecked')} 处（库里记的 ${total('stored')} 处），` +
        `平均每篇 ${(total('rechecked') / rows.length).toFixed(1)} 个`,
    )
    console.log(`  超过该难度生词预算的：${over.length}/${rows.length} 篇`)
    console.log(
      `  分类：${['abbreviation', 'proper_noun', 'wordform', 'missing_common', 'rare', 'unknown_token']
        .map((category) => `${category}=${categorySum(category)}`)
        .join(' ')}`,
    )
    console.log(
      `  若当时选方案 B（超长即 422），这几轮的成功数会从 ${docs.length} 变成 ` +
        `${docs.length - over.length}（-${((over.length / docs.length) * 100).toFixed(1)} 个百分点）`,
    )
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(async (error) => {
  console.error('[recheck-overlength] 失败：', error.message)
  process.exitCode = 1
  await mongoose.disconnect().catch(() => {})
})
