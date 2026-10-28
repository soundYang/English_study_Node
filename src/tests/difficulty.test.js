import { describe, expect, it } from 'vitest'

import { DIFFICULTY_BANDS, measureDifficulty } from '../modules/readings/difficulty.js'

/**
 * 难度客观化（md/21 W7）。
 *
 * 「easy / medium / hard」原来是三个没有定义的名字。这里守两件事：
 *   1. 同一篇正文永远得到同一个分数（纯代码，没有模型参与）；
 *   2. 常识上更难的正文分数更高——句更长、从句更多、词更罕见。
 */

const SIMPLE =
  'A boy has a book. The book is red. The boy likes the book. '
  + 'He reads it every day. The book is good.'

const COMPLEX =
  'Although the experiment was conducted under conditions that the researchers had not '
  + 'anticipated, the results were considered significant by most of the committee members '
  + 'who reviewed them before the deadline.'

describe('measureDifficulty · 可复现', () => {
  it('同一篇正文两次调用结果完全一致', () => {
    expect(measureDifficulty(COMPLEX)).toEqual(measureDifficulty(COMPLEX))
  })

  it('分数是 0–100 的整数，六项指标都有值', () => {
    const { score, metrics } = measureDifficulty(COMPLEX)

    expect(Number.isInteger(score)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
    expect(Object.keys(metrics).sort()).toEqual([
      'avgSentenceLength',
      'avgWordLength',
      'clauseDensity',
      'medianRank',
      'passiveRatio',
      'tenseVariety',
    ])
  })
})

describe('measureDifficulty · 指标语义', () => {
  it('长句 + 从句 + 被动的一篇分数更高', () => {
    expect(measureDifficulty(COMPLEX).score).toBeGreaterThan(measureDifficulty(SIMPLE).score)
  })

  it('从句密度数的是每句的标记词，不是正文词数', () => {
    const { metrics } = measureDifficulty(COMPLEX)

    // although / that / who 三个标记，全文两句话
    expect(metrics.clauseDensity).toBeGreaterThan(0)
    expect(metrics.passiveRatio).toBeGreaterThan(0)
  })

  it('词频中位数：查不到任何排名时为 null，不参与打分', () => {
    const { score, metrics } = measureDifficulty('Zzzz Qqqq Vvvv.')

    expect(metrics.medianRank).toBeNull()
    // 空转时按中等（0.5）算，分数仍然在合法区间内
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('空正文不抛错', () => {
    expect(() => measureDifficulty('')).not.toThrow()
    expect(measureDifficulty('').score).toBeGreaterThanOrEqual(0)
  })
})

describe('measureDifficulty · 区间', () => {
  it('归一化区间与权重都导出，权重之和为 1', () => {
    const weightSum = Object.values(DIFFICULTY_BANDS.WEIGHTS).reduce((a, b) => a + b, 0)

    expect(weightSum).toBeCloseTo(1, 6)
    expect(DIFFICULTY_BANDS.BANDS.avgSentenceLength.min).toBeLessThan(
      DIFFICULTY_BANDS.BANDS.avgSentenceLength.max,
    )
  })
})
