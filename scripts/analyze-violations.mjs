#!/usr/bin/env node
/**
 * 违规词分类报告（方案 §3.5）
 *
 * 数据来源是**库**，不是采样 JSON：采样文件只记了那一次跑到的汇总，
 * 而这里要按类别聚合每一轮的 counts、每个违规词的出现次数。
 *
 *   Reading.aiMeta.rounds        成功样本（含中间轮）
 *   GenerationFailure.rounds     失败样本（含中间轮）
 *   GenerationFailure.finalViolations  只有最后一轮带原句和分类
 *
 * 用法：
 *   node scripts/analyze-violations.mjs
 *   node scripts/analyze-violations.mjs --since 2026-10-28 --out md/18_违规词分类报告.md
 *   node scripts/analyze-violations.mjs --user local-user     # 换个用户看
 *
 * 只读：不删不改任何记录。
 */
import { writeFileSync } from 'node:fs'

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { VIOLATION_CATEGORIES } from '../src/modules/readings/vocabulary.service.js'

/** §3.5 的判定线 */
const THRESHOLDS = {
  missing_common: 0.5,
  proper_noun: 0.3,
  rare: 0.4,
}

const CATEGORY_LABEL = {
  abbreviation: '缩写',
  proper_noun: '专名',
  wordform: '词形/切词',
  missing_common: '常用词缺表',
  rare: '真超纲',
  unknown_token: '生造词',
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const pct = (part, total) => (total === 0 ? '0.0%' : `${((part / total) * 100).toFixed(1)}%`)

/** 一轮的 counts 可能是 undefined（篇幅超长/结构不合法时没跑词汇校验） */
function roundCounts(round) {
  if (!round?.counts) return null

  const counts = {}
  for (const category of VIOLATION_CATEGORIES) {
    const value = round.counts[category]
    // lean() 出来的可能是普通对象，也可能是 Map 化之前的子文档，两种都按数字取
    if (typeof value === 'number') counts[category] = value
  }

  return Object.keys(counts).length > 0 ? counts : null
}

function emptyTotals() {
  return Object.fromEntries(VIOLATION_CATEGORIES.map((category) => [category, 0]))
}

function addCounts(totals, counts) {
  for (const category of VIOLATION_CATEGORIES) totals[category] += counts[category] ?? 0
}

/**
 * 逐轮展开。
 * @returns {{ rounds: number, checkedRounds: number, counts: object, kinds: Map }}
 */
function collectRounds(rounds = []) {
  const counts = emptyTotals()
  const kinds = new Map()
  let checked = 0

  for (const round of rounds) {
    const values = roundCounts(round)
    const key = `${round.kind}/${round.repairFor ?? '-'}`

    if (!kinds.has(key)) kinds.set(key, { rounds: 0, checked: 0, counts: emptyTotals() })
    const bucket = kinds.get(key)
    bucket.rounds += 1

    if (values) {
      checked += 1
      addCounts(counts, values)
      addCounts(bucket.counts, values)
      bucket.checked += 1
    }
  }

  return { rounds: rounds.length, checkedRounds: checked, counts, kinds }
}

async function loadDocs({ since, user, allUsers }) {
  const filter = { createdAt: { $gte: since } }

  if (user) filter.userId = user
  // 默认只看 fixture：local-user 名下是调试期随手跑的文章，
  // 混进来会让「类别占比」同时反映两套完全不同的词库
  else if (!allUsers) filter.userId = { $regex: '^fixture-' }

  const [readings, failures] = await Promise.all([
    Reading.find(filter)
      .select('userId level targetWords targetPlan.scope createdAt actualWords aiMeta.rounds aiMeta.repairRounds aiMeta.totalTokens aiMeta.promptTokens aiMeta.completionTokens')
      .lean(),
    GenerationFailure.find(filter)
      .select('userId level targetWords scope createdAt errorCode rounds repairRounds totalTokens finalViolations finalUnknownWords available requiredWords')
      .lean(),
  ])

  return { readings, failures }
}

function aggregate({ readings, failures }) {
  const totals = emptyTotals()
  const kinds = new Map()
  const wordHits = new Map() // 词 → { category, count }
  const byFixture = new Map()
  let rounds = 0
  let checkedRounds = 0
  let finalViolationCount = 0

  const bump = (map, key, seed) => {
    if (!map.has(key)) map.set(key, seed)
    return map.get(key)
  }

  for (const fixtureKey of new Set(
    [...readings, ...failures].map((doc) => (doc.userId ?? 'unknown')),
  )) {
    byFixture.set(fixtureKey, { ok: 0, failed: 0, codes: {}, rounds: 0, counts: emptyTotals() })
  }

  for (const doc of readings) {
    const stats = byFixture.get(doc.userId)
    stats.ok += 1

    const collected = collectRounds(doc.aiMeta?.rounds)
    rounds += collected.rounds
    checkedRounds += collected.checkedRounds
    addCounts(totals, collected.counts)
    addCounts(stats.counts, collected.counts)
    stats.rounds += collected.rounds

    for (const [key, bucket] of collected.kinds) {
      const target = bump(kinds, key, { rounds: 0, checked: 0, counts: emptyTotals() })
      target.rounds += bucket.rounds
      target.checked += bucket.checked
      addCounts(target.counts, bucket.counts)
    }
  }

  for (const doc of failures) {
    const stats = byFixture.get(doc.userId)
    stats.failed += 1
    stats.codes[doc.errorCode] = (stats.codes[doc.errorCode] ?? 0) + 1

    const collected = collectRounds(doc.rounds)
    rounds += collected.rounds
    checkedRounds += collected.checkedRounds
    addCounts(totals, collected.counts)
    addCounts(stats.counts, collected.counts)
    stats.rounds += collected.rounds

    for (const [key, bucket] of collected.kinds) {
      const target = bump(kinds, key, { rounds: 0, checked: 0, counts: emptyTotals() })
      target.rounds += bucket.rounds
      target.checked += bucket.checked
      addCounts(target.counts, bucket.counts)
    }

    // 只有最后一轮的明细带分类；中间轮只有词，没有 category（§3.1.1 的已知边界）
    for (const violation of doc.finalViolations ?? []) {
      finalViolationCount += 1
      const entry = bump(wordHits, violation.normalized, {
        category: violation.category ?? 'unknown',
        count: 0,
      })
      entry.count += 1
    }
  }

  const grandTotal = VIOLATION_CATEGORIES.reduce((acc, category) => acc + totals[category], 0)

  // 按「fixture / 难度 / 篇幅 / 词源」分组：同一个 case 连跑 3 次会落在同一组。
  // fixture 必须进 key——rich 和 thin 有同名用例，混在一起会让成功率失去意义
  // 成功样本的 scope 在 targetPlan.scope 上，失败样本在顶层 scope 上
  const scopeOf = (doc) => doc.targetPlan?.scope ?? doc.scope ?? []

  const byCase = new Map()
  const caseKey = (doc) =>
    `${doc.userId}|${doc.level}/${doc.targetWords}/${scopeOf(doc).join('+') || 'all'}`

  for (const doc of [...readings, ...failures]) {
    const key = caseKey(doc)
    if (!byCase.has(key)) {
      byCase.set(key, {
        key,
        fixture: doc.userId,
        level: doc.level,
        targetWords: doc.targetWords,
        scope: scopeOf(doc).join('+') || 'all',
        runs: 0,
        ok: 0,
        words: [],
        overLength: 0,
        skippedVocabulary: 0,
        tokens: 0,
        durationMs: 0,
      })
    }

    const bucket = byCase.get(key)
    const isReading = Boolean(doc.aiMeta)
    const roundsOfDoc = doc.aiMeta?.rounds ?? doc.rounds ?? []
    const lastFeedback = roundsOfDoc.at(-1)?.feedbackType ?? null

    bucket.runs += 1
    bucket.tokens += doc.aiMeta?.totalTokens ?? doc.totalTokens ?? 0
    bucket.durationMs += doc.durationMs ?? 0

    if (isReading) {
      bucket.ok += 1
      bucket.words.push(doc.actualWords)

      // accepted 上限 = targetWords × 1.15（planAcceptedRange）
      if (doc.actualWords > Math.round(doc.targetWords * 1.15)) {
        bucket.overLength += 1
        // 末轮判的是 word_count，说明 evaluate() 没跑到词汇校验，
        // 这篇的 violationsCount 一定是 0——不是干净，是没查
        if (lastFeedback === 'word_count') bucket.skippedVocabulary += 1
      }
    }
  }

  return {
    totals,
    grandTotal,
    kinds,
    wordHits,
    byFixture,
    byCase: [...byCase.values()],
    rounds,
    checkedRounds,
    finalViolationCount,
    generations: readings.length + failures.length,
    successes: readings.length,
    failures: failures.length,
    tokens: {
      prompt: readings.reduce((acc, doc) => acc + (doc.aiMeta?.promptTokens ?? 0), 0),
      completion: readings.reduce((acc, doc) => acc + (doc.aiMeta?.completionTokens ?? 0), 0),
      total:
        readings.reduce((acc, doc) => acc + (doc.aiMeta?.totalTokens ?? 0), 0) +
        failures.reduce((acc, doc) => acc + (doc.totalTokens ?? 0), 0),
    },
    readDocs: { readings, failures },
  }
}

function verdicts({ totals, grandTotal }) {
  const rows = []

  for (const [category, threshold] of Object.entries(THRESHOLDS)) {
    const share = grandTotal === 0 ? 0 : totals[category] / grandTotal
    rows.push({
      category,
      share,
      threshold,
      hit: share >= threshold,
    })
  }

  return {
    rows,
    bugs: (totals.wordform ?? 0) + (totals.abbreviation ?? 0),
  }
}

function buildReport(data, { since, user, allUsers }) {
  const { totals, grandTotal, kinds, wordHits, byFixture, rounds, checkedRounds } = data
  const verdict = verdicts(data)
  const scope = user ? `用户 ${user}` : allUsers ? '全部用户' : '仅 fixture-* 用户'
  const lines = []

  lines.push('# 违规词分类报告')
  lines.push('')
  lines.push(`> 统计区间：${since.toISOString().slice(0, 10)} 起，${scope}`)
  lines.push(`> 样本：${data.generations} 次生成（成功 ${data.successes} / 失败 ${data.failures}），`)
  lines.push(`> 共 ${rounds} 轮模型调用，其中 ${checkedRounds} 轮跑过词汇校验。`)
  lines.push(`> 生成时间：${new Date().toISOString()}`)
  lines.push('')

  lines.push('## 1. 结论')
  lines.push('')

  if (grandTotal === 0) {
    lines.push('这个区间里没有任何违规词记录。要么没跑过生成，要么全部一次通过。')
    lines.push('')
    return { markdown: lines.join('\n'), verdict }
  }

  const ranked = [...VIOLATION_CATEGORIES].sort((a, b) => totals[b] - totals[a])
  const top = ranked[0]

  lines.push(
    `- 共记录 **${grandTotal}** 处违规词，其中 ${CATEGORY_LABEL[top]}（\`${top}\`）占 ${pct(totals[top], grandTotal)}，是最大来源。`,
  )
  lines.push(
    `- 校验器自身的 bug（\`wordform\` + \`abbreviation\`）：**${verdict.bugs}** 处` +
      (verdict.bugs > 0 ? '，按 §3.5 应当先修校验器，不要先改词表。' : '，没有。'),
  )
  lines.push(
    `- 品类判定：${verdict.rows.map((row) => `${row.category} ${pct(totals[row.category], grandTotal)} ${row.hit ? '已过线' : '未过线'}`).join('｜')}`,
  )

  const overLength = data.byCase.reduce((acc, item) => acc + item.overLength, 0)
  const skipped = data.byCase.reduce((acc, item) => acc + item.skippedVocabulary, 0)

  if (overLength > 0) {
    lines.push(
      `- **超长却跳过词汇校验：${overLength} 篇**（占成功样本 ${pct(overLength, data.successes)}）。` +
        `其中 ${skipped} 篇末轮判定是 \`word_count\`——篇幅重写额度用尽后 \`break\` 出来，` +
        '`evaluate()` 没跑到词汇校验，`violationsCount` 记成 0。' +
        '**这些「0 违规」不是干净，是没查**，统计时必须单独拎出来。',
    )
  }
  lines.push('')

  lines.push('## 2. 采样结果（按用例）')
  lines.push('')
  lines.push('| fixture | 难度 | 篇幅 | 词源 | 成功/次数 | 平均词数 | 超长 | 跳过词汇校验 | 平均 token |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const item of data.byCase.sort(
    (a, b) =>
      a.fixture.localeCompare(b.fixture) ||
      a.targetWords - b.targetWords ||
      a.level.localeCompare(b.level),
  )) {
    const avgWords =
      item.words.length === 0
        ? '—'
        : Math.round(item.words.reduce((acc, value) => acc + value, 0) / item.words.length)

    lines.push(
      `| ${item.fixture.replace('fixture-', '')} | ${item.level} | ${item.targetWords} | ${item.scope} | ${item.ok}/${item.runs} | ${avgWords} | ` +
        `${item.overLength || '—'} | ${item.skippedVocabulary || '—'} | ` +
        `${Math.round(item.tokens / item.runs)} |`,
    )
  }
  lines.push('')
  lines.push(
    `总计 ${data.generations} 次：成功 ${data.successes}（${pct(data.successes, data.generations)}），` +
      `失败 ${data.failures}；token 合计 ${data.tokens.total.toLocaleString()}。`,
  )
  lines.push('')

  lines.push('## 3. 类别分布（按违规次数）')
  lines.push('')
  lines.push('| 类别 | 含义 | 次数 | 占比 | 判定线 | 是否过线 |')
  lines.push('|---|---|---|---|---|---|')
  for (const category of ranked) {
    const row = verdict.rows.find((item) => item.category === category)
    lines.push(
      `| \`${category}\` | ${CATEGORY_LABEL[category]} | ${totals[category]} | ${pct(totals[category], grandTotal)} | ${row ? pct(row.threshold, 1) : '—'} | ${row ? (row.hit ? '**是**' : '否') : '—'} |`,
    )
  }
  lines.push('')

  lines.push('## 4. 按轮次类型')
  lines.push('')
  lines.push('看「修正轮是在修什么」：`generate/i-*` 首轮就违规，说明提示词或词表有问题；')
  lines.push('`repair/vocabulary` 仍大量产出违规，说明局部改写没有收敛。')
  lines.push('')
  lines.push('| 轮次 | 调用了 | 查过词汇 | ' + VIOLATION_CATEGORIES.join(' | ') + ' |')
  lines.push('|---|---|---|' + VIOLATION_CATEGORIES.map(() => '---').join('|') + '|')
  for (const [key, bucket] of [...kinds.entries()].sort((a, b) => b[1].rounds - a[1].rounds)) {
    lines.push(
      `| \`${key}\` | ${bucket.rounds} | ${bucket.checked} | ` +
        VIOLATION_CATEGORIES.map((category) => bucket.counts[category]).join(' | ') +
        ' |',
    )
  }
  lines.push('')

  lines.push('## 5. 每类 top 词')
  lines.push('')
  lines.push('> 只统计**失败样本的最后一轮**：中间轮只存了词，没有分类（§3.1.1 的已知边界）。')
  lines.push('> 次数 = 该词在不同样本里被判违规的次数，同一篇里重复出现只算一次。')
  lines.push('')

  for (const category of ranked) {
    const words = [...wordHits.entries()]
      .filter(([, entry]) => entry.category === category)
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))

    if (words.length === 0) continue

    lines.push(`### \`${category}\`（${CATEGORY_LABEL[category]}）· 去重 ${words.length} 个词`)
    lines.push('')
    lines.push(
      words
        .slice(0, 30)
        .map(([word, entry]) => `${word}(${entry.count})`)
        .join('、'),
    )
    lines.push('')
  }

  lines.push('## 6. 分 fixture')
  lines.push('')
  lines.push('| 用户 | 成功 | 失败 | 轮次 | 错误码 | 违规次数 |')
  lines.push('|---|---|---|---|---|---|')
  for (const [fixture, stats] of byFixture) {
    const total = VIOLATION_CATEGORIES.reduce((acc, category) => acc + stats.counts[category], 0)
    lines.push(
      `| ${fixture} | ${stats.ok} | ${stats.failed} | ${stats.rounds} | ${Object.entries(stats.codes).map(([code, count]) => `${code}×${count}`).join('<br>') || '—'} | ${total} |`,
    )
  }
  lines.push('')

  lines.push('## 7. 下一步')
  lines.push('')

  const reasons = []
  if (verdict.bugs > 0) reasons.push('`wordform` / `abbreviation` 非零 → 先修校验器（§4.3），这是 bug 不是策略')
  if (verdict.rows.find((row) => row.category === 'missing_common')?.hit) {
    reasons.push('`missing_common` 过线 → 做 §4.2 基础词表扩容')
  }
  if (verdict.rows.find((row) => row.category === 'proper_noun')?.hit) {
    reasons.push('`proper_noun` 过线 → 做 §4.1 人名放行')
  }
  if (verdict.rows.find((row) => row.category === 'rare')?.hit) {
    reasons.push('`rare` 过线 → 问题不在词表，改篇幅上限或提示词策略')
  }
  if (reasons.length === 0) {
    reasons.push('四项判据都没过线 → 样本量不足或分布均匀，先扩充样本再看')
  }

  for (const reason of reasons) lines.push(`- ${reason}`)
  lines.push('')
  lines.push(
    '> 注意：这里的「占比」分母是**所有违规次数**，不是「多少次生成失败」。' +
      '`missing_common` 占比高说明模型写得对、词表不够；`rare` 占比高才说明模型越界。',
  )
  lines.push('')

  return { markdown: lines.join('\n'), verdict }
}

async function main() {
  const sinceRaw = argValue('since', new Date().toISOString().slice(0, 10))
  const since = new Date(`${sinceRaw}T00:00:00`)
  if (Number.isNaN(since.getTime())) throw new Error(`--since 格式应为 YYYY-MM-DD，收到：${sinceRaw}`)

  const user = argValue('user', null)
  const allUsers = process.argv.includes('--all-users')
  const out = argValue('out', null)

  await mongoose.connect(config.mongodbUri)
  console.log(`mongo connected: ${mongoose.connection.name}`)

  try {
    const docs = await loadDocs({ since, user, allUsers })
    const data = aggregate(docs)
    const { markdown, verdict } = buildReport(data, { since, user, allUsers })

    console.log(
      `\n生成 ${data.generations} 次（成功 ${data.successes} / 失败 ${data.failures}），` +
        `轮次 ${data.rounds}（查过词汇 ${data.checkedRounds}），违规 ${data.grandTotal} 处`,
    )
    console.log(
      `占比：${VIOLATION_CATEGORIES.map((category) => `${category} ${pct(data.totals[category], data.grandTotal)}`).join('  ')}`,
    )
    console.log(`校验器 bug：${verdict.bugs} 处`)

    if (out) {
      writeFileSync(out, markdown)
      console.log(`\n报告已写入 ${out}`)
    } else {
      console.log('\n' + markdown)
    }
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(async (error) => {
  console.error('[analyze-violations] 失败：', error.message)
  process.exitCode = 1
  await mongoose.disconnect().catch(() => {})
})
