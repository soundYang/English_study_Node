import { describe, expect, it } from 'vitest'

import {
  POOL_LIMIT,
  filterByScope,
  neededVocabulary,
  normalizeScope,
  requiredTargetWords,
  selectVocabularyPool,
  sortCandidates,
} from '../modules/readings/vocabulary-pool.js'

const NOW = new Date('2026-10-27T12:00:00')

/** 构造一个词文档；默认「很久以前学的、从未复习、排名中等」 */
const makeWord = (word, extra = {}) => ({
  word,
  status: 'learning',
  cocaRank: 100,
  createdAt: new Date('2026-10-01T00:00:00'),
  lastReviewedAt: null,
  ...extra,
})

/** 造 n 个词，排名从 1 递增 */
const makeWords = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => makeWord(`w${String(i + 1).padStart(3, '0')}`, { cocaRank: i + 1, ...extra }))

const pool = (params) => selectVocabularyPool({ now: NOW, ...params })

describe('requiredTargetWords', () => {
  it('每 10 个正文词对应 1 个目标词', () => {
    expect(requiredTargetWords(100)).toBe(10)
    expect(requiredTargetWords(300)).toBe(30)
    expect(requiredTargetWords(500)).toBe(50)
    expect(requiredTargetWords(800)).toBe(80)
  })
})

describe('neededVocabulary', () => {
  it('按难度折算所需已学词数', () => {
    // 困难 800 词：80 ÷ 0.7 = 114.28 → 115
    expect(neededVocabulary({ targetWords: 800, level: 'hard' })).toBe(115)
    // 中等 300 词：30 ÷ 0.5 = 60
    expect(neededVocabulary({ targetWords: 300, level: 'medium' })).toBe(60)
    // 简单 800 词：80 ÷ 0.35 = 228.57 → 229
    expect(neededVocabulary({ targetWords: 800, level: 'easy' })).toBe(229)
  })
})

describe('normalizeScope', () => {
  it('空数组与未知值都回落到 all', () => {
    expect(normalizeScope([])).toEqual(['all'])
    expect(normalizeScope(['bogus'])).toEqual(['all'])
    expect(normalizeScope(undefined)).toEqual(['all'])
  })

  it('all 与其它值同时出现时只留 all', () => {
    expect(normalizeScope(['today_new', 'all'])).toEqual(['all'])
    expect(normalizeScope(['reviewing', 'all'])).toEqual(['all'])
  })

  it('重复值去重，顺序保持', () => {
    expect(normalizeScope(['today_new', 'today_new', 'today_reviewed'])).toEqual([
      'today_new',
      'today_reviewed',
    ])
  })
})

describe('filterByScope', () => {
  const words = [
    makeWord('today-new', { createdAt: new Date('2026-10-27T01:00:00') }),
    makeWord('today-reviewed', { lastReviewedAt: new Date('2026-10-27T09:00:00') }),
    makeWord('old', { createdAt: new Date('2026-10-01T01:00:00') }),
    makeWord('yesterday-reviewed', { lastReviewedAt: new Date('2026-10-26T23:00:00') }),
  ]

  it('all 返回全量', () => {
    expect(filterByScope(words, ['all'], NOW)).toHaveLength(4)
  })

  it('today_new 只留今天新建的词', () => {
    expect(filterByScope(words, ['today_new'], NOW).map((w) => w.word)).toEqual([
      'today-new',
    ])
  })

  it('today_reviewed 只留今天复习过的词', () => {
    expect(filterByScope(words, ['today_reviewed'], NOW).map((w) => w.word)).toEqual([
      'today-reviewed',
    ])
  })

  it('两个来源取并集', () => {
    expect(
      filterByScope(words, ['today_new', 'today_reviewed'], NOW).map((w) => w.word),
    ).toEqual(['today-new', 'today-reviewed'])
  })

  it('reviewing 只留复习中：排除今天新建、已掌握与墓碑', () => {
    const mixed = [
      makeWord('old-learning'),
      makeWord('today-learning', { createdAt: new Date('2026-10-27T01:00:00') }),
      makeWord('mastered', { status: 'mastered' }),
      makeWord('tombstone', { status: 'new', source: 'basic-removed' }),
    ]

    expect(filterByScope(mixed, ['reviewing'], NOW).map((w) => w.word)).toEqual([
      'old-learning',
    ])
  })

  it('reviewing 与 today_new 取并集', () => {
    const mixed = [
      makeWord('old-learning'),
      makeWord('today-learning', { createdAt: new Date('2026-10-27T01:00:00') }),
    ]

    expect(
      filterByScope(mixed, ['reviewing', 'today_new'], NOW).map((w) => w.word),
    ).toEqual(['old-learning', 'today-learning'])
  })
})

describe('sortCandidates', () => {
  it('复习优先级：久未复习 > 常规 > 已掌握', () => {
    const words = [
      makeWord('mastered', { status: 'mastered', cocaRank: 1 }),
      makeWord('recent', {
        status: 'learning',
        cocaRank: 1,
        lastReviewedAt: new Date('2026-10-26T12:00:00'),
      }),
      makeWord('stale', {
        status: 'learning',
        cocaRank: 999,
        lastReviewedAt: new Date('2026-10-01T12:00:00'),
      }),
      makeWord('never', { status: 'learning', cocaRank: 999 }),
    ]

    expect(sortCandidates(words, 'easy', NOW).map((w) => w.word)).toEqual([
      // P1：从未复习 + 超过 7 天没复习
      'never',
      'stale',
      // P2：1 天前复习过
      'recent',
      // P3：已掌握
      'mastered',
    ])
  })

  it('easy 组内由易到难，hard 组内由难到易', () => {
    const words = makeWords(5)

    expect(sortCandidates(words, 'easy', NOW).map((w) => w.cocaRank)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(sortCandidates(words, 'hard', NOW).map((w) => w.cocaRank)).toEqual([
      5, 4, 3, 2, 1,
    ])
  })

  it('排名为 null 的词按最简单处理', () => {
    const words = [makeWord('ranked', { cocaRank: 50 }), makeWord('unknown', { cocaRank: null })]

    expect(sortCandidates(words, 'easy', NOW).map((w) => w.word)).toEqual([
      'unknown',
      'ranked',
    ])
  })
})

describe('selectVocabularyPool', () => {
  it('按难度比例截断：200 个词 → easy 70 / medium 100 / hard 140', () => {
    const words = makeWords(200)

    expect(pool({ words, level: 'easy', targetWords: 100 }).poolSize).toBe(70)
    expect(pool({ words, level: 'medium', targetWords: 100 }).poolSize).toBe(100)
    expect(pool({ words, level: 'hard', targetWords: 100 }).poolSize).toBe(140)
  })

  it('候选池封顶 800', () => {
    const words = makeWords(3000)

    expect(pool({ words, level: 'hard', targetWords: 800 }).poolSize).toBe(POOL_LIMIT)
  })

  it('池子足够时 sufficient 为 true，并给出计划数字', () => {
    const result = pool({ words: makeWords(200), level: 'hard', targetWords: 800 })

    expect(result.sufficient).toBe(true)
    expect(result.available).toBe(200)
    expect(result.requiredWords).toBe(80)
    expect(result.neededVocab).toBe(115)
    expect(result.poolSize).toBe(140)
  })

  it('池子不足时 sufficient 为 false，并带回 required / available', () => {
    const result = pool({ words: makeWords(45), level: 'hard', targetWords: 800 })

    expect(result.sufficient).toBe(false)
    expect(result.available).toBe(45)
    expect(result.neededVocab).toBe(115)
  })

  it('scope 过滤后再判断是否足够', () => {
    const words = [
      ...makeWords(50).map((w) => ({ ...w, createdAt: new Date('2026-10-27T02:00:00') })),
      ...makeWords(50),
    ]

    const result = pool({
      words,
      level: 'hard',
      targetWords: 800,
      scope: ['today_new'],
    })

    expect(result.available).toBe(50)
    expect(result.sufficient).toBe(false)
    expect(result.scope).toEqual(['today_new'])
  })

  it('返回的词形按优先级与难度排好序，不带文档字段', () => {
    const result = pool({
      words: [makeWord('harder', { cocaRank: 900 }), makeWord('easier', { cocaRank: 10 })],
      level: 'easy',
      targetWords: 100,
    })

    expect(result.pool).toEqual(['easier', 'harder'])
    expect(typeof result.pool[0]).toBe('string')
  })
})
