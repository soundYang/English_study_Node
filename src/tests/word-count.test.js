import { describe, expect, it } from 'vitest'

import { WORD_COUNT, countWords, planWordRange } from '../modules/readings/word-count.js'

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

describe('countWords', () => {
  it('连字符与撇号算一个词', () => {
    expect(countWords("Tom's well-known book.")).toBe(3)
  })

  it('非字符串输入不抛错', () => {
    expect(countWords(null)).toBe(0)
    expect(countWords(undefined)).toBe(0)
  })
})
