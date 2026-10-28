#!/usr/bin/env node
/**
 * 离线回归：把历史正文跑一遍当前校验链路，几秒出结果，不花一分钱。
 *
 * 三种模式：
 *   node scripts/replay-suite.mjs            对比 samples/replay/expected.json
 *   node scripts/replay-suite.mjs --report   打印分组报表，不做对比
 *   node scripts/replay-suite.mjs --update   重写 expected.json（改词表/改规则后用）
 *
 * 判定的是**不变量**，不是成功率：
 *   · unknownCount ≤ 该难度的生词预算（easy 0 / medium 3 / hard 5）
 *   · counts 之和 = violations 条数
 *   · 成功样本的结构仍然合法
 * 任何一条在某个样本上翻转，脚本都会指名道姓地打出来。
 *
 * 与真调模型的关系：这里不替代 §7 的 45 次采样，它替代的是
 * 「改完先跑一遍看看有没有把别的样本改坏」这件本该 5 秒完成的事。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from '../src/config/index.js'
import { basicWordsByLevel } from '../src/modules/readings/basic-words.js'
import { LEVEL_LIMITS, unknownBudgetFor } from '../src/modules/readings/level-limits.js'
import {
  basicWordsVersion,
  basicWordsVersions,
  codeVersion,
} from '../src/modules/readings/versions.js'
import { budgetFor, replayAll, summarize } from './lib/replay-core.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'samples', 'replay', 'fixtures.json')
const EXPECTED = join(ROOT, 'samples', 'replay', 'expected.json')

function parseArgs(argv) {
  const args = { update: false, report: false, basic: null, fixtures: FIXTURES }

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--update') args.update = true
    else if (argv[i] === '--report') args.report = true
    else if (argv[i] === '--basic' && argv[i + 1]) args.basic = resolve(argv[++i])
    else if (argv[i] === '--fixtures' && argv[i + 1]) args.fixtures = resolve(argv[++i])
  }

  return args
}

function loadBasicList(file) {
  // 不给 --basic 时按难度分档；给了就统一覆盖（用于验证「换表影响哪些样本」）
  if (!file) return basicWordsByLevel

  const list = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(list)) throw new Error(`${file} 不是字符串数组`)

  return list.map((word) => String(word).toLowerCase())
}

/** 只保留稳定的字段做金标准；id 之外的元数据变化不该让回归失败 */
function toComparable(result) {
  return {
    id: result.id,
    kind: result.kind,
    actualWords: result.actualWords,
    unknownCount: result.unknownCount,
    counts: result.counts,
    structure: result.structure,
  }
}

function printReport(summary, results, basicLabel, budget) {
  const budgetLabel = typeof budget === 'number'
    ? String(budget)
    : Object.entries(budget).map(([level, value]) => `${level}=${value}`).join(' / ')
  console.log(`\n允许词表：${basicLabel}　生词预算：${budgetLabel}`)
  console.log(`样本 ${summary.cases} 篇（跳过空正文若干）　平均表外词 ${summary.averageUnknown}\n`)

  console.log('难度/篇幅    样本  历史成功  现超预算  平均表外词')
  for (const group of summary.groups) {
    const average = (group.unknownTotal / group.cases).toFixed(1)
    console.log(
      `${group.key.padEnd(12)} ${String(group.cases).padStart(4)}  `
        + `${String(group.accepted).padStart(8)}  ${String(group.overBudget).padStart(8)}  `
        + `${average.padStart(10)}`,
    )
  }

  console.log('\n违规分类合计：')
  for (const [category, count] of Object.entries(summary.categoryTotals)) {
    if (count > 0) console.log(`  ${category.padEnd(16)} ${count}`)
  }

  // §6.8 的量化口径：库里记着干净、复算却不干净的那批
  console.log(
    `\n历史「看起来干净」但复算有表外词的样本：${summary.storedSaysClean} 篇`
      + `（这部分就是当初 violationsCount 为假 0 的记录）`,
  )

  const overBudget = results.filter((item) => !item.withinBudget)
  if (overBudget.length > 0) {
    console.log('\n超预算样本：')
    for (const item of overBudget.slice(0, 20)) {
      console.log(
        `  ${item.id}  ${item.level}/${item.targetWords}  `
          + `表外 ${item.unknownCount} 词，${item.actualWords} 词`,
      )
    }
    if (overBudget.length > 20) console.log(`  … 另有 ${overBudget.length - 20} 篇`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!existsSync(args.fixtures)) {
    console.error(`缺少夹具：${args.fixtures}`)
    console.error('先运行：node scripts/export-replay-fixtures.mjs')
    process.exit(1)
  }

  const fixtures = JSON.parse(readFileSync(args.fixtures, 'utf8'))
  const basicList = loadBasicList(args.basic)
  const basicLabel = args.basic
    ? args.basic.split(/[\\/]/).pop()
    : Object.entries(basicWordsByLevel)
        .map(([level, list]) => `${level}=${list.length}`)
        .join(' / ')
  // 预算按难度取（easy 0 / medium 3 / hard 5）；MAX_UNKNOWN_WORDS 显式设置时压成同一个数
  const budget = Object.fromEntries(
    Object.keys(LEVEL_LIMITS).map((level) => [
      level,
      unknownBudgetFor(level, config.maxUnknownWordsOverride),
    ]),
  )

  const { results, skipped } = replayAll(fixtures, basicList, budget)
  const summary = summarize(results)

  printReport(summary, results, basicLabel, budget)
  if (skipped.length > 0) console.log(`\n空正文跳过 ${skipped.length} 篇`)

  // 结构性不变量：每天都在，任何一条破了都是代码 bug
  const broken = []
  for (const result of results) {
    if (!result.counts) continue

    const countSum = Object.values(result.counts).reduce((sum, count) => sum + count, 0)
    if (countSum !== result.violationCount) {
      broken.push(`${result.id}: counts 之和 ${countSum} ≠ violations ${result.violationCount}`)
    }
    if (result.withinBudget !== (result.unknownCount <= budgetFor(budget, result.level))) {
      broken.push(`${result.id}: withinBudget 与 unknownCount 不一致`)
    }
  }

  if (broken.length > 0) {
    console.error('\n不变量被破坏：')
    for (const line of broken) console.error(`  ${line}`)
    process.exit(1)
  }

  const comparable = results.map(toComparable)

  if (args.report) return

  if (args.update) {
    writeFileSync(
      EXPECTED,
      `${JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          basicWordsVersion,
          basicWordsVersions,
          codeVersion,
          budget,
          results: comparable,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`\n已更新金标准：${EXPECTED}（${comparable.length} 条，basicWordsVersion ${basicWordsVersion}）`)
    return
  }

  if (!existsSync(EXPECTED)) {
    console.error(`\n缺少金标准：${EXPECTED}`)
    console.error('首次使用请先运行：node scripts/replay-suite.mjs --update')
    process.exit(1)
  }

  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'))
  const previous = new Map(expected.results.map((item) => [item.id, item]))
  const diffs = []

  for (const current of comparable) {
    const before = previous.get(current.id)

    if (!before) {
      diffs.push(`+ ${current.id}：金标准里没有（新增样本？需要 --update）`)
      continue
    }
    if (JSON.stringify(before) !== JSON.stringify(current)) {
      diffs.push(
        `! ${current.id}：表外词 ${before.unknownCount}→${current.unknownCount}，`
          + `实际词数 ${before.actualWords}→${current.actualWords}，`
          + `结构 ${before.structure}→${current.structure}`,
      )
    }
  }

  for (const id of previous.keys()) {
    if (!comparable.some((item) => item.id === id)) diffs.push(`- ${id}：当前样本里没有了`)
  }

  if (diffs.length > 0) {
    console.error(`\n与金标准不一致 ${diffs.length} 处：`)
    for (const line of diffs) console.error(`  ${line}`)
    console.error('\n确认是预期改动后运行：node scripts/replay-suite.mjs --update')
    process.exit(1)
  }

  console.log(`\n✅ 与金标准一致（${comparable.length} 条，basicWordsVersion ${basicWordsVersion}）`)
}

main()
