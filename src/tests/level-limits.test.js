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
 * 三道门禁的数字（md/21 W3）。
 *
 * 这些常量是「难度」唯一的产品定义：改一个数字，生成与 /capacity 会
 * 同时变化。测试守的是数字本身、口径（个人词库 ∪ 基础词表 ∪ 日历词），
 * 以及那个最容易做错的边界：功能词不参与个人基础词的减法。
 */

const fakeWords = (count, prefix = 'known') =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`)

/** 基础词 + 日历词去重后的并集大小（may 同时出现在两份清单里） */
const baseUnion = (level) => new Set([...basicWordsByLevel[level], ...calendarWords]).size

describe('LEVEL_LIMITS', () => {
  it('三档数字与 md/20 §2.2 一致', () => {
    expect(LEVEL_LIMITS).toEqual({
      easy: { maxTargetWords: 300, requiredKnown: 1000, unknownBudget: 0 },
      medium: { maxTargetWords: 450, requiredKnown: 1900, unknownBudget: 3 },
      hard: { maxTargetWords: 600, requiredKnown: 3778, unknownBudget: 5 },
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
    expect(result.requiredKnown).toBe(1000)
    expect(result.sufficient).toBe(false)
    expect(result.shortage).toBe(1000 - baseUnion('easy'))
  })

  it('刚好够 / 差一个', () => {
    const needed = 1000 - baseUnion('easy')
    const short = measureKnownVocabulary({
      level: 'easy',
      learnedWords: fakeWords(needed - 1),
    })
    const exact = measureKnownVocabulary({
      level: 'easy',
      learnedWords: fakeWords(needed),
    })

    expect(short.sufficient).toBe(false)
    expect(short.shortage).toBe(1)
    expect(exact.knownWords).toBe(1000)
    expect(exact.sufficient).toBe(true)
    expect(exact.shortage).toBe(0)
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

  it('hard 的个人词下限 = 3778 −（2578 基础 ∪ 日历）', () => {
    const needed = 3778 - baseUnion('hard')
    const almost = measureKnownVocabulary({
      level: 'hard',
      learnedWords: fakeWords(needed - 1),
    })
    const enough = measureKnownVocabulary({
      level: 'hard',
      learnedWords: fakeWords(needed),
    })

    expect(almost.sufficient).toBe(false)
    expect(almost.shortage).toBe(1)
    expect(enough.sufficient).toBe(true)
  })
})
