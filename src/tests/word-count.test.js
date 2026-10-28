import { describe, expect, it } from 'vitest'

import {
  WORD_COUNT,
  classifyLength,
  countWords,
  formatWordsPerSentence,
  planAcceptedRange,
  planExpandBudget,
  planSentenceBudget,
  planWordRange,
} from '../modules/readings/word-count.js'

/**
 * 篇幅口径是全项目唯一来源：提示词、DTO、校验、日志都读这里。
 * 这些数字一旦漂移，界面上的「预计 220 词」就会和提示词里的 200–230 对不上。
 */
describe('planWordRange', () => {
  it('200 词 → 目标 220、上限 230', () => {
    expect(planWordRange(200)).toEqual({
      min: 200,
      target: 220,
      max: 230,
      label: '200–230 词',
    })
  })

  it('100 与 800 两个端点都落在 1.15 倍以内', () => {
    for (const targetWords of [100, 800]) {
      const range = planWordRange(targetWords)

      expect(range.min).toBe(targetWords)
      expect(range.max).toBe(Math.round(targetWords * WORD_COUNT.MAX_RATIO))
      expect(range.target).toBeLessThanOrEqual(range.max)
      expect(range.target).toBeGreaterThanOrEqual(range.min)
    }
  })
})

describe('planSentenceBudget', () => {
  it('200 词请求 → 约 15 句、每句 14–15 词（按目标值反推）', () => {
    expect(planSentenceBudget(planWordRange(200))).toEqual({
      sentences: 15,
      minSentences: 14,
      maxSentences: 16,
      minWordsPerSentence: 14,
      maxWordsPerSentence: 15,
    })
  })

  it('上下界相同时只显示一个数字', () => {
    expect(formatWordsPerSentence({ minWordsPerSentence: 15, maxWordsPerSentence: 15 })).toBe('15')
    expect(formatWordsPerSentence({ minWordsPerSentence: 14, maxWordsPerSentence: 15 })).toBe(
      '14–15',
    )
  })

  it('每句词数由区间决定，不会随句子数飘走', () => {
    for (const targetWords of [100, 200, 400, 800]) {
      const range = planWordRange(targetWords)
      const budget = planSentenceBudget(range)

      expect(budget.minWordsPerSentence * budget.minSentences).toBeLessThanOrEqual(range.target)
      expect(budget.maxWordsPerSentence * budget.maxSentences).toBeGreaterThanOrEqual(range.target)
    }
  })

  it('句子预算与词数区间同量级：15 句 × 15 词 ≈ 目标', () => {
    for (const targetWords of [100, 200, 400, 800]) {
      const range = planWordRange(targetWords)
      const budget = planSentenceBudget(range)

      expect(budget.sentences * 15).toBeGreaterThanOrEqual(range.min)
      expect(budget.sentences * 15).toBeLessThanOrEqual(range.max)
    }
  })

  it('极短篇幅也至少给 3 句', () => {
    expect(planSentenceBudget({ min: 20, target: 22, max: 23 }).minSentences).toBe(3)
  })
})

describe('planAcceptedRange', () => {
  it('200 词请求的验收区间是 ±15%：170–230', () => {
    expect(planAcceptedRange(200)).toEqual({
      min: 170,
      target: 220,
      max: 230,
      label: '170–230 词',
    })
  })

  it('提示词区间仍然是 200–230，验收更宽', () => {
    const asked = planWordRange(200)
    const accepted = planAcceptedRange(200)

    expect(accepted.min).toBeLessThan(asked.min)
    expect(accepted.max).toBe(asked.max)
  })
})

describe('classifyLength', () => {
  const accepted = planAcceptedRange(200) // 170–230

  it('落在验收区间内是 ok，边界含进去', () => {
    expect(classifyLength(170, accepted)).toBe('ok')
    expect(classifyLength(200, accepted)).toBe('ok')
    expect(classifyLength(230, accepted)).toBe('ok')
  })

  it('低于验收下限是 short，高于上限是 long', () => {
    expect(classifyLength(169, accepted)).toBe('short')
    expect(classifyLength(0, accepted)).toBe('short')
    expect(classifyLength(231, accepted)).toBe('long')
  })

  it('90 词的 100 词请求算 ok：验收下界比提示词下界低', () => {
    // 用提示词区间（100–115）判的话，这类正常文章会全被标成 short，指标失去信号
    expect(classifyLength(90, planAcceptedRange(100))).toBe('ok')
    expect(classifyLength(84, planAcceptedRange(100))).toBe('short')
  })
})

describe('planExpandBudget', () => {
  it('按目标词（1.1 倍）算缺口，每 15 词一句', () => {
    expect(planExpandBudget(90, planWordRange(100))).toEqual({ shortfall: 20, sentences: 2 })
    expect(planExpandBudget(60, planWordRange(100))).toEqual({ shortfall: 50, sentences: 3 })
  })

  it('句子数封顶 3：补太多等于重写', () => {
    expect(planExpandBudget(10, planWordRange(400)).sentences).toBe(3)
  })

  it('已经很接近目标时至少补一句', () => {
    expect(planExpandBudget(109, planWordRange(100))).toEqual({ shortfall: 1, sentences: 1 })
  })
})

describe('countWords', () => {
  it('连字符与撇号算一个词', () => {
    expect(countWords("Tom's well-known book.")).toBe(3)
  })

  it('非字符串输入不抛错', () => {
    expect(countWords(null)).toBe(0)
    expect(countWords(undefined)).toBe(0)
  })
})
