import { describe, expect, it } from 'vitest'

import { ABBREVIATIONS, ABBREVIATION_WORDS } from '../modules/readings/abbreviations.js'
import { validateArticle } from '../modules/readings/vocabulary.service.js'

/**
 * 缩写是「词的简写」，词典和基础词表都不收，必须自带全称与释义，
 * 否则前端「缩写」分组只能显示一串孤零零的缩写。
 */
describe('ABBREVIATIONS', () => {
  it('每一项都有全称和中文释义', () => {
    for (const [key, value] of Object.entries(ABBREVIATIONS)) {
      expect(key).toBe(key.toLowerCase())
      expect(value.expansion).toBeTruthy()
      expect(value.meaning).toBeTruthy()
    }
  })

  it('ABBREVIATION_WORDS 与表键一致', () => {
    expect(ABBREVIATION_WORDS).toEqual(Object.keys(ABBREVIATIONS))
  })

  it('歧义缩写不收', () => {
    for (const ambiguous of ['st', 'no', 'min', 'sec']) {
      expect(ABBREVIATIONS).not.toHaveProperty(ambiguous)
    }
  })
})

describe('带点缩写的切词', () => {
  // us / in / the 都在基础 600 词里，这里手工放进来
  const allowed = new Set(['tom', 'is', 'a', 'boy', 'in', 'the', 'us', ...ABBREVIATION_WORDS])

  it('Dr. 切成 dr 并放行', () => {
    const result = validateArticle({ article: 'Dr. Tom is a boy.', allowedWords: allowed })

    expect(result.unknownWords).toEqual([])
  })

  it('U.S. 归一成 us，不会被拆成 u 和 s', () => {
    const result = validateArticle({ article: 'Tom is in the U.S.', allowedWords: allowed })

    expect(result.unknownWords).toEqual([])
  })

  it('缩写没进白名单时照样判违规', () => {
    const narrowed = new Set(['tom', 'is', 'a', 'boy'])

    const result = validateArticle({ article: 'Dr. Tom is a boy.', allowedWords: narrowed })

    expect(result.unknownWords).toEqual(['dr'])
  })
})
