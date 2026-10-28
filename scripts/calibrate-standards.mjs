#!/usr/bin/env node
/**
 * 三档基础词表标定（md/21 W2，只读）。
 *
 * 回答一个问题：**每个难度到底需要多大的基础词表**。
 *
 * 原来 600 / 1200 / 2578 是拍出来的数字。这里用历史成功正文实测：
 *   · 对每个（文章难度 × 候选词表）组合，算「表外词 ≤ 该难度预算」的通过率；
 *   · 每条规则取「通过率 ≥ 90% 的最小词表」作为推荐；
 *   · 用 P90 补词数 + 该难度篇幅上限对应的 neededVocab，推出个人词库下限。
 *
 * 输入是 `samples/replay/fixtures.json`（`npm run fixtures:export` 生成），
 * 只统计历史**成功**样本——失败样本本来就不该通过。
 *
 * 只读：不写文件、不调模型、不改词表。数字抄进 md/21 §2 后再手动改代码。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { basicWordsByLevel } from '../src/modules/readings/basic-words.js'
import { validateArticle } from '../src/modules/readings/vocabulary.service.js'
import { neededVocabulary } from '../src/modules/readings/vocabulary-pool.js'
import { buildAllowedWords, extractArticle } from './lib/replay-core.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'samples', 'replay', 'fixtures.json')

const LEVELS = ['easy', 'medium', 'hard']
const TIERS = ['easy', 'medium', 'hard']

/** 目标预算与篇幅上限：与 md/20 §2 的表一致；W3 落地后应改为从 level-limits 读取 */
const BUDGET = { easy: 0, medium: 3, hard: 5 }
const TARGET_CAP = { easy: 300, medium: 450, hard: 600 }

/** 通过率门槛：md/20 §3「取通过率 ≥ 90% 的最小表」 */
const PASS_THRESHOLD = 0.9

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index]
}

const ceilTo50 = (value) => Math.ceil(value / 50) * 50

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
      if (unknownWords.length <= BUDGET[testCase.level]) bucket.pass += 1
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

  console.log('\n补词数（清零该目录全部表外词所需）')
  console.log('难度     ' + TIERS.map((tier) => tier.padStart(14)).join(''))

  for (const level of LEVELS) {
    const cells = TIERS.map((tier) => {
      const sorted = [...matrix[level][tier].unknown].sort((a, b) => a - b)
      return `P50 ${percentile(sorted, 0.5)} / P90 ${percentile(sorted, 0.9)}`.padStart(14)
    })
    console.log(`${level.padEnd(8)} ${cells.join('')}`)
  }

  console.log('\n推荐（通过率 ≥ 90% 的最小表）')

  for (const level of LEVELS) {
    const recommended = TIERS.find((tier) => {
      const bucket = matrix[level][tier]
      return bucket.n > 0 && bucket.pass / bucket.n >= PASS_THRESHOLD
    }) ?? 'hard'

    const sorted = [...matrix[level][recommended].unknown].sort((a, b) => a - b)
    const p90 = percentile(sorted, 0.9)
    const needed = neededVocabulary({ targetWords: TARGET_CAP[level], level })
    const userFloor = ceilTo50(needed + p90)
    const requiredKnown = basicWordsByLevel[recommended].length + userFloor

    console.log(
      `${level.padEnd(8)} 词表 ${recommended}(${basicWordsByLevel[recommended].length})  `
        + `个人词库下限 ${userFloor}（neededVocab ${needed} + P90 ${p90}）  `
        + `requiredKnown ${requiredKnown}`,
    )
  }

  console.log('\n词表增量')
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
