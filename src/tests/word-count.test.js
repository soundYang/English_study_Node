import { describe, expect, it } from 'vitest'

import {
  SENTENCE,
  WORD_COUNT,
  classifyLength,
  countWords,
  formatWordsPerSentence,
  planAcceptedRange,
  planExpandBudget,
  planSentenceBudget,
  planWordRange,
  segmentWordCeiling,
  wordsPerSentenceFor,
} from '../modules/readings/word-count.js'

/**
 * 篇幅口径是全项目唯一来源：提示词、DTO、校验、日志都读这里。
 * 这些数字一旦漂移，界面上的「预计 220 词」就会和提示词里的 200–220 对不上。
 */
describe('planWordRange', () => {
  it('200 词 → 目标 220、提示词上限 220', () => {
    expect(planWordRange(200)).toEqual({
      min: 200,
      target: 220,
      max: 220,
      label: '200–220 词',
    })
  })

  it('提示词上限比重写上界低 5%，模型有操作余量（md/30 §6-1）', () => {
    for (const targetWords of [100, 200, 600, 1000]) {
      const range = planWordRange(targetWords)
      const accepted = planAcceptedRange(targetWords)

      expect(range.min).toBe(targetWords)
      expect(range.max).toBe(Math.round(targetWords * WORD_COUNT.WRITE_RATIO))
      expect(range.max).toBeLessThan(accepted.max)
      expect(range.target).toBeLessThanOrEqual(range.max)
      expect(range.target).toBeGreaterThanOrEqual(range.min)
    }
  })
})

describe('planSentenceBudget', () => {
  it('200 词请求 → 约 15 句、每句 14 词（按目标值反推）', () => {
    expect(planSentenceBudget(planWordRange(200))).toEqual({
      sentences: 15,
      minSentences: 14,
      maxSentences: 16,
      minWordsPerSentence: 14,
      maxWordsPerSentence: 14,
    })
  })

  it('上下界相同时只显示一个数字', () => {
    expect(formatWordsPerSentence({ minWordsPerSentence: 15, maxWordsPerSentence: 15 })).toBe('15')
    expect(formatWordsPerSentence({ minWordsPerSentence: 14, maxWordsPerSentence: 15 })).toBe(
      '14–15',
    )
  })

  it('每句词数是目标值除以句数取整，误差不超过一句', () => {
    for (const targetWords of [100, 200, 400, 800]) {
      const range = planWordRange(targetWords)
      const budget = planSentenceBudget(range)

      // 提示词上界与目标值相等之后，每句只有一个数（floor(target/句数)），
      // 整篇 = 句数 × 每句词数，和目标的差就是取整丢掉的零头
      expect(budget.minWordsPerSentence).toBe(
        Math.floor(range.target / budget.sentences),
      )
      expect(
        Math.abs(budget.minWordsPerSentence * budget.sentences - range.target),
      ).toBeLessThanOrEqual(budget.sentences)
      expect(budget.minSentences).toBeLessThanOrEqual(budget.sentences)
      expect(budget.maxSentences).toBeGreaterThanOrEqual(budget.sentences)
    }
  })

  it('句子预算与词数区间同量级：句数 × 15 贴着目标值（±半句）', () => {
    for (const targetWords of [100, 200, 400, 800]) {
      const range = planWordRange(targetWords)
      const budget = planSentenceBudget(range)

      expect(budget.sentences * 15).toBeGreaterThanOrEqual(range.min)
      // 目标值不一定能被 15 整除，差半句以内都算贴着
      expect(Math.abs(budget.sentences * 15 - range.target)).toBeLessThanOrEqual(8)
    }
  })

  it('极短篇幅也至少给 3 句', () => {
    expect(planSentenceBudget({ min: 20, target: 22, max: 23 }).minSentences).toBe(3)
  })

  it('每句基准词数按难度取，不传 level 时退回 15（旧口径）', () => {
    const range = planWordRange(200)

    // easy 12 词/句 → 18 句；hard 19 词/句 → 12 句；未传 → 15 词/句 → 15 句
    expect(planSentenceBudget(range, 'easy').sentences).toBe(18)
    expect(planSentenceBudget(range, 'hard').sentences).toBe(12)
    expect(planSentenceBudget(range).sentences).toBe(15)
    expect(wordsPerSentenceFor('insane')).toBe(SENTENCE.WORDS_PER_SENTENCE)
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

  it('验收区间两头都比提示词宽：模型欠写/超写各留 15% 余量', () => {
    const asked = planWordRange(200)
    const accepted = planAcceptedRange(200)

    expect(accepted.min).toBeLessThan(asked.min)
    expect(accepted.max).toBeGreaterThan(asked.max)
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

  it('补几句按该难度的句长折算：同样差 30 词，easy 要多补一句', () => {
    const range = planWordRange(100) // target 110
    // 差 30 词：easy 12 词/句 → 3 句；hard 19 词/句 → 2 句
    expect(planExpandBudget(80, range, 'easy').sentences).toBe(3)
    expect(planExpandBudget(80, range, 'hard').sentences).toBe(2)
  })
})

describe('segmentWordCeiling', () => {
  it('单段上限是 maxWords × 1.15（与整篇验收同一个口径）', () => {
    expect(segmentWordCeiling(50)).toBe(58)
    expect(segmentWordCeiling(60)).toBe(69)
    expect(segmentWordCeiling(100)).toBe(115)
  })

  it('十段各卡在上限时，全文仍在 ±15% 窗口内', () => {
    const perSegment = 60 // 600 词 / 10 段
    expect(segmentWordCeiling(perSegment) * 10).toBeLessThanOrEqual(Math.round(600 * 1.15))
  })

  it('非法输入不返回 NaN', () => {
    expect(segmentWordCeiling(0)).toBe(0)
    expect(segmentWordCeiling(-5)).toBe(0)
    expect(segmentWordCeiling('many')).toBe(0)
    expect(segmentWordCeiling(null)).toBe(0)
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
