import { describe, expect, it } from 'vitest'

import {
  FOCUS_RATIO,
  REPEAT_PLAN,
  buildTargetPlan,
} from '../modules/readings/target-plan.js'

/** 造一批词形，顺序即「已排好序」的顺序 */
const makePool = (n) =>
  Array.from({ length: n }, (_, i) => `w${String(i + 1).padStart(4, '0')}`)

/** 默认走 medium，逐个用例只关心真正在测的那个参数 */
const plan = (params) => buildTargetPlan({ level: 'medium', ...params })

describe('buildTargetPlan', () => {
  it('篇幅换算成目标词数：每 10 词 1 个', () => {
    const pool = makePool(1000)

    expect(plan({ pool, targetWords: 100 }).requiredWords).toBe(10)
    expect(plan({ pool, targetWords: 300 }).requiredWords).toBe(30)
    expect(plan({ pool, targetWords: 500 }).requiredWords).toBe(50)
    expect(plan({ pool, targetWords: 800 }).requiredWords).toBe(80)
  })

  it('重点词占目标词的 35%，四舍五入', () => {
    const pool = makePool(1000)

    // 10 × 0.35 = 3.5 → 4
    expect(plan({ pool, targetWords: 100 }).focusWords).toHaveLength(4)
    // 30 × 0.35 = 10.5 → 11
    expect(plan({ pool, targetWords: 300 }).focusWords).toHaveLength(11)
    // 50 × 0.35 = 17.5 → 18
    expect(plan({ pool, targetWords: 500 }).focusWords).toHaveLength(18)
    // 80 × 0.35 = 28
    expect(plan({ pool, targetWords: 800 }).focusWords).toHaveLength(28)
  })

  it('三段互不重叠，并集恰好等于整个池子', () => {
    const pool = makePool(1000)
    const result = plan({ pool, targetWords: 300 })

    const merged = [
      ...result.focusWords,
      ...result.targetWords,
      ...result.supportWords,
    ]

    expect(merged).toHaveLength(pool.length)
    expect(new Set(merged).size).toBe(pool.length)
    expect(merged).toEqual(pool)
  })

  it('池子装不下目标词数时，其余段位为空数组而不是报错', () => {
    const result = plan({ pool: makePool(5), targetWords: 300 })

    expect(result.requiredWords).toBe(30)
    // 池子只有 5 个，全被切进重点词
    expect(result.focusWords).toHaveLength(5)
    expect(result.targetWords).toEqual([])
    expect(result.supportWords).toEqual([])
  })

  it('顺序保持：重点词是池子的前缀，普通目标词紧随其后', () => {
    const pool = makePool(100)
    const result = plan({ pool, targetWords: 300 })

    expect(result.focusWords).toEqual(pool.slice(0, 11))
    expect(result.targetWords).toEqual(pool.slice(11, 30))
    expect(result.supportWords).toEqual(pool.slice(30))
  })

  it('复现计划原样透传，方便提示词直接读', () => {
    const result = plan({ pool: makePool(100), targetWords: 300 })

    expect(result.repeatPlan).toBe(REPEAT_PLAN)
    expect(result.repeatPlan.focus).toEqual({ min: 2, max: 3 })
    expect(result.repeatPlan.target).toEqual({ min: 1, max: 2 })
  })

  it('重点词比例是 0.35（写死会被断言拦住）', () => {
    expect(FOCUS_RATIO).toBe(0.35)
  })
})
