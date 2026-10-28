/**
 * 采样汇总的纯计算部分（md/21 W8）。
 *
 * 与 replay-core 一样，把「读库」和「算数」分开：
 * CLI（scripts/summarize-runs.mjs）只负责查询与打印，这里的函数不认识 Mongo，
 * 才能用固定样本断言每一项指标的定义。
 */

/**
 * DeepSeek 官方价（元 / 百万 token），2025-09 调整后的一档。
 * 价格会变，所以允许用环境变量覆盖；报告里会带上实际使用的价格。
 * 默认值只用于「数量级判断」，不要拿它对账。
 */
export const DEFAULT_PRICES = Object.freeze({
  cacheHit: 0.2,
  cacheMiss: 2,
  output: 3,
})

const number = (value) => (Number.isFinite(value) ? value : 0)

/** 一篇文章的费用（元）：命中缓存与未命中的输入单价不同 */
export function roundsCost(rounds = [], prices = DEFAULT_PRICES) {
  return rounds.reduce((sum, round) => {
    const hit = number(round.cacheHitTokens)
    const prompt = number(round.promptTokens)
    const miss = Math.max(0, prompt - hit)

    return (
      sum
      + (hit * prices.cacheHit + miss * prices.cacheMiss + number(round.completionTokens) * prices.output)
        / 1_000_000
    )
  }, 0)
}

/** 旧文档没有总耗时字段，用每轮 durationMs 之和近似 */
export function requestDuration(doc) {
  if (Number.isFinite(doc?.durationMs)) return doc.durationMs
  return (doc?.aiMeta?.rounds ?? []).reduce((sum, round) => sum + number(round.durationMs), 0)
}

/** 线性插值的分位数；values 会就地排序副本 */
export function percentile(values, p) {
  if (!values.length) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))

  return sorted[index]
}

const ratio = (numerator, denominator) =>
  denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null

function emptyBucket(key) {
  return {
    key,
    requests: 0,
    success: 0,
    firstPass: 0,
    repairs: 0,
    tokens: 0,
    cost: 0,
    unknownWords: 0,
    withViolations: 0,
    coverageSum: 0,
    coverageCount: 0,
    lengthChecked: 0,
    lengthOk: 0,
    durations: [],
  }
}

function addReading(bucket, doc, prices) {
  const ai = doc.aiMeta ?? {}
  const repairs = number(ai.repairRounds)

  bucket.requests += 1
  bucket.success += 1
  bucket.repairs += repairs
  if (repairs === 0) bucket.firstPass += 1
  bucket.tokens += number(ai.totalTokens)
  bucket.cost += roundsCost(ai.rounds, prices)
  bucket.durations.push(requestDuration(doc))

  const unknown = number(ai.violationsCount)
  bucket.unknownWords += unknown
  if (unknown > 0) bucket.withViolations += 1

  if (ai.targetUsage && Number.isFinite(ai.targetUsage.coverageRate)) {
    bucket.coverageSum += ai.targetUsage.coverageRate
    bucket.coverageCount += 1
  }

  // 长度合格率按验收区间 ±15% 近似；acceptedRange 没有落库，只能用偏差反推
  if (Number.isFinite(ai.wordCountDeviation)) {
    bucket.lengthChecked += 1
    if (ai.wordCountDeviation >= 0.85 && ai.wordCountDeviation <= 1.15) bucket.lengthOk += 1
  }
}

function addFailure(bucket, doc, prices) {
  bucket.requests += 1
  bucket.repairs += number(doc.repairRounds)
  bucket.tokens += number(doc.totalTokens)
  bucket.cost += roundsCost(doc.rounds, prices)
  bucket.durations.push(requestDuration(doc))
  bucket.unknownWords += (doc.finalUnknownWords ?? []).length
  bucket.withViolations += 1
}

/** 单篇费用常在 0.005 元上下，用 3 位小数会全部化成 0.00x，所以单独保留 6 位 */
const money = (numerator, denominator) =>
  denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null

function finalize(bucket) {
  return {
    key: bucket.key,
    requests: bucket.requests,
    success: bucket.success,
    firstPass: bucket.firstPass,
    finalRate: ratio(bucket.success, bucket.requests),
    firstPassRate: ratio(bucket.firstPass, bucket.requests),
    avgRepairs: ratio(bucket.repairs, bucket.requests),
    avgUnknownWords: ratio(bucket.unknownWords, bucket.requests),
    violationRate: ratio(bucket.withViolations, bucket.requests),
    lengthOkRate: ratio(bucket.lengthOk, bucket.lengthChecked),
    coverageRate: ratio(bucket.coverageSum, bucket.coverageCount),
    avgTokens: Math.round(ratio(bucket.tokens, bucket.requests) ?? 0),
    avgCost: money(bucket.cost, bucket.requests),
    totalCost: Number(bucket.cost.toFixed(6)),
    avgDurationMs: Math.round(ratio(
      bucket.durations.reduce((sum, value) => sum + value, 0),
      bucket.durations.length,
    ) ?? 0),
    p95DurationMs: Math.round(percentile(bucket.durations, 0.95)),
  }
}

const keyOf = (doc) => {
  const ai = doc.aiMeta ?? {}

  return [
    ai.basicWordsVersion ?? doc.basicWordsVersion ?? 'unknown',
    ai.strategy ?? doc.strategy ?? 'whole(legacy)',
    doc.level ?? '?',
    doc.targetWords ?? '?',
  ].join(' | ')
}

/**
 * 按「版本 × 策略 × 难度 × 篇幅」分组。
 *
 * @param {{ readings?: object[], failures?: object[], prices?: typeof DEFAULT_PRICES }} input
 * @returns {{ rows: object[], totals: object }}
 */
export function summarizeRuns({ readings = [], failures = [], prices = DEFAULT_PRICES } = {}) {
  const buckets = new Map()
  const get = (doc) => {
    const key = keyOf(doc)
    if (!buckets.has(key)) buckets.set(key, emptyBucket(key))

    return buckets.get(key)
  }

  for (const reading of readings) addReading(get(reading), reading, prices)
  for (const failure of failures) addFailure(get(failure), failure, prices)

  const rows = [...buckets.values()]
    .map(finalize)
    .sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'))

  const total = emptyBucket('总计')
  for (const reading of readings) addReading(total, reading, prices)
  for (const failure of failures) addFailure(total, failure, prices)

  return { rows, totals: finalize(total) }
}

/** 表格里的百分比列统一格式 */
export const formatRate = (value) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
export const formatNumber = (value) => (value === null ? '—' : String(value))
export const formatCost = (value) => (value === null ? '—' : `¥${value.toFixed(4)}`)
