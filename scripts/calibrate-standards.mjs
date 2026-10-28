#!/usr/bin/env node
/**
 * 三档基础词表标定（md/21 W2，只读）。
 *
 * ⚠️ **2026-10-28 起结论已作废**（md/27 §6-5）：产品决定「基础词汇只有 easy 这 600 多个」，
 * 三档共用同一份表（md/30 §7）。篇幅 ↔ 词汇量的门槛改由
 * `capacity-table.js` 的 `minKnownFor(N)` 按篇幅给，不再存在
 * 「每档基础表要多大 / requiredKnown 该是多少」这两个问题。
 *
 * 保留脚本只为 pass-rate 矩阵与 P50/P90 补词数——它们仍能回答
 * 「历史正文里有多少表外词」，是与 `unknownBudget` 对齐的诊断数据。
 * **不要按输出里的数字改代码**，现行标准以 `capacity-table.js` 为准。
 *
 * 输入是 `samples/replay/fixtures.json`（`npm run fixtures:export` 生成），
 * 只统计历史**成功**样本——失败样本本来就不该通过。
 *
 * 只读：不写文件、不调模型、不改词表。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { basicWordsByLevel, getBasicWords } from '../src/modules/readings/basic-words.js'
import { baseMaxWordsFor, minKnownFor } from '../src/modules/readings/capacity-table.js'
import { unknownBudgetFor } from '../src/modules/readings/level-limits.js'
import { validateArticle } from '../src/modules/readings/vocabulary.service.js'
import { buildAllowedWords, extractArticle } from './lib/replay-core.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'samples', 'replay', 'fixtures.json')

const LEVELS = ['easy', 'medium', 'hard']
const TIERS = ['easy', 'medium', 'hard']

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index]
}

function main() {
  if (!existsSync(FIXTURES)) {
    console.error(`缺少夹具：${FIXTURES}`)
    console.error('先运行：npm run fixtures:export')
    process.exit(1)
  }

  const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'))
  const cases = fixtures.cases.filter((item) => item.source === 'reading')

  const matrix = Object.fromEntries(
    LEVELS.map((level) => [
      level,
      Object.fromEntries(TIERS.map((tier) => [tier, { n: 0, pass: 0, unknown: [] }])),
    ]),
  )

  for (const testCase of cases) {
    const article = testCase.kind === 'plain'
      ? testCase.article
      : extractArticle(testCase.article).article
    if (!article) continue

    const user = fixtures.users[testCase.userId] ?? {}

    for (const tier of TIERS) {
      const allowed = buildAllowedWords(user, basicWordsByLevel[tier])
      const { unknownWords } = validateArticle({
        article,
        allowedWords: allowed,
        names: testCase.names ?? [],
      })

      const bucket = matrix[testCase.level][tier]
      bucket.n += 1
      bucket.unknown.push(unknownWords.length)
      if (unknownWords.length <= unknownBudgetFor(testCase.level)) bucket.pass += 1
    }
  }

  console.log(`样本：${cases.length} 篇历史成功正文\n`)
  console.log('通过率（表外词 ≤ 该难度预算）')
  console.log('难度     ' + TIERS.map((tier) => `${tier}(${basicWordsByLevel[tier].length})`.padStart(14)).join(''))

  for (const level of LEVELS) {
    const cells = TIERS.map((tier) => {
      const bucket = matrix[level][tier]
      const rate = bucket.n ? bucket.pass / bucket.n : 0
      return `${bucket.pass}/${bucket.n} ${(rate * 100).toFixed(0)}%`.padStart(14)
    })
    console.log(`${level.padEnd(8)} ${cells.join('')}`)
  }

  console.log('\n补词数（清零该档表外词所需；历史口径，不是现行门槛）')
  console.log('难度     ' + TIERS.map((tier) => tier.padStart(14)).join(''))

  for (const level of LEVELS) {
    const cells = TIERS.map((tier) => {
      const sorted = [...matrix[level][tier].unknown].sort((a, b) => a - b)
      return `P50 ${percentile(sorted, 0.5)} / P90 ${percentile(sorted, 0.9)}`.padStart(14)
    })
    console.log(`${level.padEnd(8)} ${cells.join('')}`)
  }

  console.log('\n现行标准（以 capacity-table.js 为准，上面的数字不要拿来改代码）')

  for (const level of LEVELS) {
    const cap = baseMaxWordsFor(level)

    console.log(
      `${level.padEnd(8)} 基础词表 easy(${getBasicWords().length})  `
        + `常规上限 ${cap} 词 → minKnown ${minKnownFor(cap, level)}  `
        + `生词预算 ${unknownBudgetFor(level)}`,
    )
  }

  console.log(
    `  hard 最终模式：personalWords ≥ 3000 时上限 1000 词，minKnown 不参与判定（生成时置 0）`,
  )

  console.log('\n词表增量（medium / hard 两份文件仍在，但生成链路不再按难度取表）')
  for (let index = 1; index < TIERS.length; index += 1) {
    const previous = new Set(basicWordsByLevel[TIERS[index - 1]])
    const added = basicWordsByLevel[TIERS[index]].filter((word) => !previous.has(word))
    console.log(
      `  ${TIERS[index - 1]} → ${TIERS[index]}：+${added.length} 词，`
        + `例：${added.slice(0, 8).join(', ')}`,
    )
  }
}

main()
