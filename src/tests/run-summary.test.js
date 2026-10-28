import { describe, expect, it } from 'vitest'

import {
  percentile,
  requestDuration,
  roundsCost,
  summarizeRuns,
} from '../../scripts/lib/run-summary.mjs'

/**
 * W8：采样汇总的指标定义。
 *
 * 这张表是用来对比「换策略前 / 换策略后」的，一旦口径漂了，
 * 结论就会跟着漂，所以每一项都用固定样本断言到小数位。
 */

const prices = { cacheHit: 1, cacheMiss: 2, output: 3 }

const readings = [
  {
    // 分段路径，一次过
    level: 'medium',
    targetWords: 300,
    durationMs: 1000,
    aiMeta: {
      basicWordsVersion: 'v1',
      strategy: 'segmented',
      repairRounds: 0,
      totalTokens: 1000,
      rounds: [{ cacheHitTokens: 400, promptTokens: 500, completionTokens: 200 }],
      violationsCount: 0,
      targetUsage: { coverageRate: 0.9 },
      wordCountDeviation: 1.0,
    },
  },
  {
    // 分段路径，段内修了一轮，且仍有 2 个违规词
    level: 'medium',
    targetWords: 300,
    durationMs: 2000,
    aiMeta: {
      basicWordsVersion: 'v1',
      strategy: 'segmented',
      repairRounds: 1,
      totalTokens: 2000,
      rounds: [{ promptTokens: 1000, completionTokens: 400 }],
      violationsCount: 2,
      targetUsage: { coverageRate: 0.7 },
      wordCountDeviation: 1.3,
    },
  },
  {
    // W4 之前的老文档：没有 strategy，也没有 durationMs
    level: 'easy',
    targetWords: 200,
    aiMeta: {
      basicWordsVersion: 'v1',
      repairRounds: 2,
      totalTokens: 900,
      rounds: [{ cacheHitTokens: 100, promptTokens: 200, completionTokens: 100, durationMs: 3000 }],
      violationsCount: 0,
      wordCountDeviation: 0.9,
    },
  },
]

const failures = [
  {
    level: 'medium',
    targetWords: 300,
    basicWordsVersion: 'v1',
    strategy: 'segmented',
    repairRounds: 2,
    totalTokens: 1500,
    durationMs: 2500,
    finalUnknownWords: ['alpha', 'beta', 'gamma'],
    rounds: [{ promptTokens: 1000, completionTokens: 500 }],
  },
]

const { rows, totals } = summarizeRuns({ readings, failures, prices })

describe('roundsCost', () => {
  it('命中与未命中分别计价，输出单独计价', () => {
    const cost = roundsCost([{ cacheHitTokens: 400, promptTokens: 500, completionTokens: 200 }], prices)

    expect(cost).toBeCloseTo((400 * 1 + 100 * 2 + 200 * 3) / 1_000_000, 10)
  })

  it('缺字段按 0 处理', () => {
    expect(roundsCost([{}], prices)).toBe(0)
    expect(roundsCost(undefined, prices)).toBe(0)
  })
})

describe('requestDuration', () => {
  it('优先用总耗时', () => {
    expect(requestDuration({ durationMs: 1234, aiMeta: { rounds: [] } })).toBe(1234)
  })

  it('老文档用每轮耗时之和近似', () => {
    expect(requestDuration(readings[2])).toBe(3000)
  })
})

describe('percentile', () => {
  it('空数组为 0，单值为它自己', () => {
    expect(percentile([], 0.95)).toBe(0)
    expect(percentile([5], 0.95)).toBe(5)
  })

  it('取最近的秩，不插值', () => {
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4) // ceil(3.8) - 1 = 3
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2) // ceil(2) - 1 = 1
  })
})

describe('summarizeRuns 分组', () => {
  it('按「版本 × 策略 × 难度 × 篇幅」分组，老文档标 whole(legacy)', () => {
    expect(rows.map((row) => row.key)).toEqual([
      'v1 | segmented | medium | 300',
      'v1 | whole(legacy) | easy | 200',
    ])
  })

  it('分段组：失败样本也计入分母', () => {
    const row = rows[0]

    expect(row.requests).toBe(3) // 2 篇成功 + 1 次失败
    expect(row.success).toBe(2)
    expect(row.finalRate).toBe(0.667)
    expect(row.firstPass).toBe(1)
    expect(row.firstPassRate).toBe(0.333)
    expect(row.avgRepairs).toBe(1) // (0 + 1 + 2) / 3
    expect(row.violationRate).toBe(0.667) // r2 有 2 个违规 + 失败样本
  })

  it('生词数：成功样本取 violationsCount，失败样本取 finalUnknownWords 长度', () => {
    expect(rows[0].avgUnknownWords).toBe(1.667) // (0 + 2 + 3) / 3
    expect(rows[1].avgUnknownWords).toBe(0)
  })

  it('长度合格率按偏差 ±15% 近似', () => {
    expect(rows[0].lengthOkRate).toBe(0.5) // 1.0 合格、1.3 不合格
    expect(rows[1].lengthOkRate).toBe(1) // 0.9
  })

  it('覆盖率只统计有 targetUsage 的成功样本', () => {
    expect(rows[0].coverageRate).toBe(0.8) // (0.9 + 0.7) / 2
    expect(rows[1].coverageRate).toBe(null) // 老文档没有这一项
  })

  it('费用按命中 / 未命中 / 输出三档算出', () => {
    expect(rows[0].totalCost).toBeCloseTo(0.0079, 10)
    expect(rows[0].avgCost).toBeCloseTo(0.002633, 10)
    expect(rows[1].totalCost).toBeCloseTo(0.0006, 10)
  })

  it('token 与耗时取平均，P95 取高分位', () => {
    expect(rows[0].avgTokens).toBe(1500)
    expect(rows[0].avgDurationMs).toBe(1833)
    expect(rows[0].p95DurationMs).toBe(2500)
  })

  it('总计把两组并起来', () => {
    expect(totals.key).toBe('总计')
    expect(totals.requests).toBe(4)
    expect(totals.success).toBe(3)
    expect(totals.finalRate).toBe(0.75)
    expect(totals.firstPassRate).toBe(0.25)
    expect(totals.avgRepairs).toBe(1.25) // (0+1+2+2) / 4
    expect(totals.avgTokens).toBe(1350)
    expect(totals.avgDurationMs).toBe(2125)
    expect(totals.p95DurationMs).toBe(3000)
    expect(totals.totalCost).toBeCloseTo(0.0085, 10)
  })

  it('没有样本时返回空分组和全 0 的总计，而不是抛错', () => {
    const empty = summarizeRuns()

    expect(empty.rows).toEqual([])
    expect(empty.totals.requests).toBe(0)
    expect(empty.totals.finalRate).toBe(null)
    expect(empty.totals.lengthOkRate).toBe(null)
    expect(empty.totals.avgTokens).toBe(0)
    expect(empty.totals.totalCost).toBe(0)
  })
})
