import { describe, expect, it } from 'vitest'

import { buildSegmentPlan, planSegmentCount } from '../modules/readings/plan.service.js'
import { planWordRange } from '../modules/readings/word-count.js'

/**
 * 纯函数测试：计划修正不依赖模型，也不依赖数据库。
 * 这里要证明的是「模型给什么形状，代码都能得到一份可执行的计划」。
 */

describe('planSegmentCount', () => {
  it('按 60 词一段切，夹在 3–10 段之间', () => {
    expect(planSegmentCount(100)).toBe(3) // 2 → 下限 3
    expect(planSegmentCount(180)).toBe(3)
    expect(planSegmentCount(300)).toBe(5)
    expect(planSegmentCount(600)).toBe(10) // 10 → 上限 10
    expect(planSegmentCount(1200)).toBe(10)
  })
})

describe('buildSegmentPlan — 代码补齐', () => {
  const plan = (raw, targetWords = 100) =>
    buildSegmentPlan({
      raw,
      targetWords,
      targetWordList: ['alpha', 'beta', 'gamma', 'delta'],
      range: planWordRange(targetWords),
    })

  it('模型什么都不给：仍是 3 段，目标词全部均摊、篇幅落在区间内', () => {
    const segments = plan(null)

    expect(segments).toHaveLength(3)
    expect(segments.map((item) => item.id)).toEqual([1, 2, 3])
    expect(segments.every((item) => item.goal.length > 0)).toBe(true)

    const words = segments.flatMap((item) => item.mustUse)
    expect([...words].sort()).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    expect(new Set(words).size).toBe(words.length) // 不相交

    const sum = segments.reduce((acc, item) => acc + item.maxWords, 0)
    expect(sum).toBeGreaterThanOrEqual(100)
    expect(sum).toBeLessThanOrEqual(115)
  })

  it('mustUse 只认目标词，跨段去重，漏掉的由代码补进最少的段', () => {
    const segments = plan({
      segments: [
        { id: 1, goal: '开头', mustUse: ['alpha', 'the', 'ALPHA'], maxWords: 40 },
        { id: 2, goal: '中间', mustUse: ['alpha', 'beta'], maxWords: 40 },
      ],
    })

    // 'the' 不是目标词，丢掉；第二段的 alpha 是重复，丢掉。
    // 剩下的 gamma / delta：先补进最空的第 3 段，再平票补回第 1 段
    expect(segments[0].mustUse).toEqual(['alpha', 'delta'])
    expect(segments[1].mustUse).toEqual(['beta'])
    expect(segments[2].mustUse).toEqual(['gamma'])

    const words = segments.flatMap((item) => item.mustUse)
    expect([...words].sort()).toEqual(['alpha', 'beta', 'delta', 'gamma'])
  })

  it('段数不足时补段，且补出来的段也分到目标词', () => {
    const segments = plan({ segments: [{ goal: '只有一段', mustUse: ['alpha'], maxWords: 40 }] })

    expect(segments).toHaveLength(3)
    expect(segments[1].goal).toContain('第 2 段')
    expect(segments.flatMap((item) => item.mustUse).sort()).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
    ])
  })

  it('各段 maxWords 之和跑出区间 → 按比例缩放回区间', () => {
    const segments = plan({
      segments: [
        { goal: 'a', mustUse: [], maxWords: 100 },
        { goal: 'b', mustUse: [], maxWords: 100 },
        { goal: 'c', mustUse: [], maxWords: 100 },
      ],
    })

    const sum = segments.reduce((acc, item) => acc + item.maxWords, 0)
    expect(sum).toBeGreaterThanOrEqual(100)
    expect(sum).toBeLessThanOrEqual(115)
  })

  it('不合法的 maxWords（越界 / 非整数）回落到平均篇幅', () => {
    const segments = plan({
      segments: [
        { goal: 'a', mustUse: [], maxWords: 5 },
        { goal: 'b', mustUse: [], maxWords: 9999 },
        { goal: 'c', mustUse: [], maxWords: 'many' },
      ],
    })

    // 三段都回落成 round(110 / 3) = 37，总和 111 已在区间内
    expect(segments.map((item) => item.maxWords)).toEqual([37, 37, 37])
  })
})
