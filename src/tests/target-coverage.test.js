import { describe, expect, it } from 'vitest'

import { measureTargetCoverage } from '../modules/readings/target-coverage.js'

/**
 * W5：覆盖度是纯函数，喂手工正文断言六项指标的精确值。
 * 这里刻意让「3 个没出现、1 个出现 9 次」同时成立——两个异常都能被看见。
 */

describe('measureTargetCoverage', () => {
  const article =
    'Alpha alpha beta. Delta delta delta delta delta delta delta delta delta.'

  const coverage = measureTargetCoverage({
    article,
    focusWords: ['alpha', 'gamma'],
    targetWords: ['beta', 'delta', 'epsilon', 'zeta'],
    requiredWords: 6,
  })

  it('覆盖率 = 出现过的不同目标词 / requiredWords', () => {
    expect(coverage.coverageRate).toBe(0.5) // alpha / beta / delta 三个，共 6 个
  })

  it('总出现次数含重复', () => {
    expect(coverage.totalOccurrences).toBe(12) // 2 + 1 + 9
  })

  it('重点词按「复现 ≥2 次」计', () => {
    expect(coverage.focusRepeatRate).toBe(0.5) // alpha 达到，gamma 没出现
  })

  it('未出现与超量分别列出', () => {
    expect(coverage.unused).toEqual(['gamma', 'epsilon', 'zeta'])
    expect(coverage.overused).toEqual(['delta']) // 9 次 > 6
  })

  it('密度 = 目标词 token / 正文 token', () => {
    expect(coverage.densityScore).toBe(1) // 12 / 12
  })
})

describe('measureTargetCoverage — 词形与边界', () => {
  it('词形变化计入：runs / running 都算在 run 上', () => {
    const result = measureTargetCoverage({
      article: 'Runs running.',
      focusWords: [],
      targetWords: ['run'],
      requiredWords: 1,
    })

    expect(result.totalOccurrences).toBe(2)
    expect(result.coverageRate).toBe(1)
  })

  it('空正文 / 零分母不会算出 NaN', () => {
    const result = measureTargetCoverage({
      article: '',
      targetWords: ['alpha'],
      requiredWords: 0,
    })

    expect(result).toEqual({
      coverageRate: 0,
      totalOccurrences: 0,
      focusRepeatRate: 0,
      unused: ['alpha'],
      overused: [],
      densityScore: 0,
    })
  })
})
