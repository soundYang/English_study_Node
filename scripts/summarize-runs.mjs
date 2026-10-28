#!/usr/bin/env node
/**
 * 采样汇总（md/21 W8）
 *
 * 把 Reading（成功样本）与 GenerationFailure（失败样本）放在同一张表里，
 * 按「基础词表版本 × 生成策略 × 难度 × 篇幅」分组，输出：
 *   首次成功率 / 最终成功率 / 平均修复轮数 / 平均生词数 / 长度合格率 /
 *   目标词覆盖率 / 平均 token / 平均耗时 / P95 耗时 / 平均费用。
 *
 * 为什么必须分组：换了策略（whole → segmented）或换了基础词表之后，
 * 混在一起的数字既不能证明变好，也不能证明变坏。
 *
 * 用法：
 *   node scripts/summarize-runs.mjs                 # 最近 30 天
 *   node scripts/summarize-runs.mjs --days 0        # 全部
 *   node scripts/summarize-runs.mjs --user local-user
 *   node scripts/summarize-runs.mjs --json           # 机器可读
 *
 * 价格默认取 scripts/lib/run-summary.mjs 的 DEFAULT_PRICES，
 * 可用环境变量 PRICE_CACHE_HIT / PRICE_CACHE_MISS / PRICE_OUTPUT 覆盖（元/百万 token）。
 *
 * ⚠️ 只读。不写库、不调模型、不产生费用。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import {
  DEFAULT_PRICES,
  formatCost,
  formatNumber,
  formatRate,
  summarizeRuns,
} from './lib/run-summary.mjs'

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)

  return index === -1 ? fallback : process.argv[index + 1]
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

/** 价格可以被环境变量覆盖；读不到就用默认值 */
function pricesFromEnv() {
  const read = (key, fallback) => {
    const value = Number(process.env[key])
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }

  return {
    cacheHit: read('PRICE_CACHE_HIT', DEFAULT_PRICES.cacheHit),
    cacheMiss: read('PRICE_CACHE_MISS', DEFAULT_PRICES.cacheMiss),
    output: read('PRICE_OUTPUT', DEFAULT_PRICES.output),
  }
}

/** 终端里中文占两格，直接 padEnd 会让表头错位 */
function displayWidth(text) {
  return [...String(text)].reduce((width, char) => width + (/[一-鿿]/.test(char) ? 2 : 1), 0)
}

function pad(text, width) {
  const value = String(text)
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}

const COLUMNS = [
  ['版本', 8],
  ['策略', 13], // whole(legacy) 就有 13 个字符，窄了会把整行顶歪
  ['难度', 6],
  ['篇幅', 5],
  ['请求', 5],
  ['首次%', 7],
  ['最终%', 7],
  ['修复/篇', 8],
  ['生词/篇', 8],
  ['长度%', 7],
  ['覆盖', 6],
  ['token', 8],
  ['耗时', 7],
  ['P95', 7],
  ['费用/篇', 9],
]

function rowCells(row) {
  // key = 版本 | 策略 | 难度 | 篇幅；总计行的 key 只有一段，缺的补空
  const [version, strategy, level, targetWords] = [
    ...row.key.split(' | '),
    '', '', '', '',
  ].slice(0, 4)

  return [
    version.slice(0, 8),
    strategy,
    level,
    targetWords,
    formatNumber(row.requests),
    formatRate(row.firstPassRate),
    formatRate(row.finalRate),
    formatNumber(row.avgRepairs),
    formatNumber(row.avgUnknownWords),
    formatRate(row.lengthOkRate),
    formatRate(row.coverageRate),
    formatNumber(row.avgTokens),
    `${row.avgDurationMs}ms`,
    `${row.p95DurationMs}ms`,
    formatCost(row.avgCost),
  ]
}

function printTable(rows) {
  const header = COLUMNS.map(([name, width]) => pad(name, width)).join('  ')
  const divider = COLUMNS.map(([, width]) => '-'.repeat(width)).join('  ')

  console.log(header)
  console.log(divider)

  for (const row of rows) {
    console.log(rowCells(row).map((cell, index) => pad(cell, COLUMNS[index][1])).join('  '))
  }
}

async function main() {
  const days = Number(argValue('days', '30'))
  const user = argValue('user')
  const since = Number.isFinite(days) && days > 0
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    : null

  const filter = {}
  if (user) filter.userId = user
  if (since) filter.createdAt = { $gte: since }

  await mongoose.connect(config.mongodbUri)

  try {
    const [readings, failures] = await Promise.all([
      Reading.find(filter).lean(),
      GenerationFailure.find(filter).lean(),
    ])

    const prices = pricesFromEnv()
    const { rows, totals } = summarizeRuns({ readings, failures, prices })

    if (hasFlag('json')) {
      console.log(JSON.stringify({
        filters: { user: user ?? null, days, since },
        prices,
        rows,
        totals,
      }, null, 2))

      return
    }

    console.log(`样本：成功 ${readings.length} 篇，失败 ${failures.length} 次` +
      `（${since ? `最近 ${days} 天` : '全部'}${user ? `，用户 ${user}` : ''}）`)
    console.log('')

    if (!rows.length) {
      console.log('没有样本。')
      return
    }

    printTable(rows)
    console.log('')
    printTable([totals])

    console.log('')
    console.log('口径：')
    console.log('  首次%   = repairRounds 为 0 的篇数 / 请求数（分段路径 = 所有段一次通过）')
    console.log('  最终%   = 成功文章数 / 请求数（失败样本来自 GenerationFailure）')
    console.log('  长度%   = wordCountDeviation 落在 0.85–1.15 的篇数 / 有偏差数据的篇数')
    console.log('  覆盖    = aiMeta.targetUsage.coverageRate 的平均值（W5，仅成功样本）')
    console.log('  策略    = whole(legacy) 表示 W4 之前、没有记录策略的老样本')
    console.log(
      `  费用    = 命中 ¥${prices.cacheHit}/M、未命中 ¥${prices.cacheMiss}/M、` +
        `输出 ¥${prices.output}/M（可用环境变量覆盖）`,
    )
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(async (error) => {
  console.error('[summarize-runs] 失败：', error.message)
  process.exitCode = 1
  await mongoose.disconnect().catch(() => {})
})
