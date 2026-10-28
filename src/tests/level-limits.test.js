import { describe, expect, it } from 'vitest'

import { basicWordsByLevel } from '../modules/readings/basic-words.js'
import { calendarWords } from '../modules/readings/calendar-words.js'
import {
  LEVEL_LIMITS,
  limitOf,
  measureKnownVocabulary,
  unknownBudgetFor,
} from '../modules/readings/level-limits.js'

/**
 * 难度的两个常量（md/21 W3）与已知词汇量的口径。
 *
 * md/30 §7 之后，第三个常量 `requiredKnown`（按难度写死的已知词下限）已删除，
 * 改由 `capacity-table.js` 的 `minKnownFor(N)` 按篇幅给——那份表的测试在
 * `capacity-table.test.js`。本文件只守剩下的数字、并集口径，
 * 以及那个最容易做错的边界：功能词不参与个人基础词的减法。
 */

const fakeWords = (count, prefix = 'known') =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`)

/**
 * 基础词 + 日历词去重后的并集大小（may 同时出现在两份清单里）。
 *
 * 2026-10-28 起基础词汇全档只有 easy 600 这一份（`getBasicWords()` 不再按档取表），
 * 所以这里三档算出来是同一个数。保留 `level` 参数是为了让断言读起来仍能指到档位。
 */
const baseUnion = () => new Set([...basicWordsByLevel.easy, ...calendarWords]).size

describe('LEVEL_LIMITS', () => {
  it('只剩篇幅上限与生词预算，requiredKnown 已删除（md/30 §7）', () => {
    expect(LEVEL_LIMITS).toEqual({
      easy: { maxTargetWords: 300, unknownBudget: 0 },
      medium: { maxTargetWords: 450, unknownBudget: 3 },
      hard: { maxTargetWords: 600, unknownBudget: 5 },
    })
  })

  it('未知难度按 easy 处理：宁可少放行', () => {
    expect(limitOf('insane')).toBe(LEVEL_LIMITS.easy)
    expect(limitOf(undefined)).toBe(LEVEL_LIMITS.easy)
  })

  it('生词预算按难度取，显式覆盖时三档压成同一个数', () => {
    expect(unknownBudgetFor('easy')).toBe(0)
    expect(unknownBudgetFor('medium')).toBe(3)
    expect(unknownBudgetFor('hard')).toBe(5)

    // .env 的 MAX_UNKNOWN_WORDS 是覆盖项，不是第二套默认值
    expect(unknownBudgetFor('easy', 5)).toBe(5)
    expect(unknownBudgetFor('hard', 0)).toBe(0)
    // 非整数（含 null）视为没设置
    expect(unknownBudgetFor('medium', null)).toBe(3)
    expect(unknownBudgetFor('medium', 2.5)).toBe(3)
  })
})

describe('measureKnownVocabulary', () => {
  it('口径是并集：个人词库 ∪ 该档基础表 ∪ 日历词', () => {
    const result = measureKnownVocabulary({ level: 'easy', learnedWords: [] })

    expect(result.knownWords).toBe(baseUnion('easy'))
    // 只回两个字段：够不够取决于请求的篇幅，函数本身不知道 N
    expect(Object.keys(result).sort()).toEqual(['knownWords', 'personalBasicWords'])
  })

  it('个人词逐个累加，且与基础表去重', () => {
    const learned = fakeWords(37)
    const result = measureKnownVocabulary({ level: 'easy', learnedWords: learned })

    expect(result.knownWords).toBe(baseUnion('easy') + 37)
  })

  it('与基础表重复的个人词不会重复计数', () => {
    const overlap = basicWordsByLevel.easy.slice(0, 10)
    const result = measureKnownVocabulary({ level: 'easy', learnedWords: overlap })

    expect(result.knownWords).toBe(baseUnion('easy'))
  })

  it('用户标成 new 的基础词会被扣掉，并反映到已知词量', () => {
    const learned = fakeWords(500)
    const before = measureKnownVocabulary({ level: 'easy', learnedWords: learned })
    const after = measureKnownVocabulary({
      level: 'easy',
      learnedWords: learned,
      removedBasicWords: ['book', 'house'],
    })

    expect(after.personalBasicWords).toHaveLength(before.personalBasicWords.length - 2)
    expect(after.knownWords).toBe(before.knownWords - 2)
  })

  it('功能词不可移除：the 被标 new 时个人基础词不变', () => {
    const learned = fakeWords(500)
    const before = measureKnownVocabulary({ level: 'easy', learnedWords: learned })
    const after = measureKnownVocabulary({
      level: 'easy',
      learnedWords: learned,
      removedBasicWords: ['the', 'is'],
    })

    expect(after.personalBasicWords).toEqual(before.personalBasicWords)
    expect(after.knownWords).toBe(before.knownWords)
  })

  it('三档共用同一份基础表：同一批词在三档算出同一个 knownWords', () => {
    const learned = fakeWords(120)
    const values = ['easy', 'medium', 'hard'].map(
      (level) => measureKnownVocabulary({ level, learnedWords: learned }).knownWords,
    )

    expect(new Set(values).size).toBe(1)
  })
})
