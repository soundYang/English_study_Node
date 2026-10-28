import { describe, expect, it } from 'vitest'

import { resolveBaseForms } from '../shared/utils/word.js'
import { validateArticle } from '../modules/readings/vocabulary.service.js'
import { buildWordClosure, isHyphenatedAllowed } from '../modules/readings/word-closure.js'

/**
 * 词形闭包（md/21 W1）。
 *
 * 两条防线：
 *   1. 该放行的必须放行——larger / sixty-year-old / happily；
 *   2. 不该放行的绝不能放行——business 不因 bus 在表里而合法。
 * 第 2 条比第 1 条重要：闭包放宽「允许」，一旦放宽过头，
 * 真违规会被洗成合法，而这类错误没有任何日志能看出来。
 */

const closureOf = (...words) => buildWordClosure(words)

const validate = (article, allowedWords) =>
  validateArticle({ article, allowedWords })

describe('buildWordClosure · 规则变形', () => {
  it('复数 / 三单：+s、+es、y→ies', () => {
    expect(closureOf('book').has('books')).toBe(true)
    expect(closureOf('watch').has('watches')).toBe(true)
    expect(closureOf('study').has('studies')).toBe(true)
  })

  it('过去式：+ed、+d、y→ied、双写辅音', () => {
    expect(closureOf('play').has('played')).toBe(true)
    expect(closureOf('like').has('liked')).toBe(true)
    expect(closureOf('study').has('studied')).toBe(true)
    expect(closureOf('stop').has('stopped')).toBe(true)
  })

  it('现在分词：+ing、去 e、双写、ie→ying', () => {
    expect(closureOf('play').has('playing')).toBe(true)
    expect(closureOf('make').has('making')).toBe(true)
    expect(closureOf('run').has('running')).toBe(true)
    expect(closureOf('lie').has('lying')).toBe(true)
  })

  it('比较级 / 最高级：e 结尾 +r/+st（larger 的正向来源）', () => {
    const closure = closureOf('large')
    expect(closure.has('larger')).toBe(true)
    expect(closure.has('largest')).toBe(true)
  })

  it('比较级 / 最高级：y→ier/iest、双写辅音', () => {
    expect(closureOf('happy').has('happier')).toBe(true)
    expect(closureOf('happy').has('happiest')).toBe(true)
    expect(closureOf('big').has('bigger')).toBe(true)
    expect(closureOf('big').has('biggest')).toBe(true)
  })

  it('副词：+ly、y→ily、辅音+le→y', () => {
    expect(closureOf('quick').has('quickly')).toBe(true)
    expect(closureOf('happy').has('happily')).toBe(true)
    expect(closureOf('simple').has('simply')).toBe(true)
  })

  it('反例：business 不会从 bus 生成', () => {
    expect(closureOf('bus').has('business')).toBe(false)
    expect(closureOf('bus').has('buses')).toBe(true)
  })

  it('反例：carpet 不会从 car 生成', () => {
    expect(closureOf('car').has('carpet')).toBe(false)
  })

  it('连字符 / 撇号词不参与变形', () => {
    const closure = buildWordClosure(['part-time', "don't"])
    expect(closure.size).toBe(0)
  })

  it('不生成无元音的伪词', () => {
    expect(closureOf('by').has('byd')).toBe(false)
  })
})

describe('resolveBaseForms · 比较级长词还原', () => {
  it('larger → large、simplest → simple', () => {
    expect(resolveBaseForms('larger')).toContain('large')
    expect(resolveBaseForms('simplest')).toContain('simple')
  })
})

describe('isHyphenatedAllowed', () => {
  const allow = (word) => ['part', 'time', 'sixty', 'year', 'old'].includes(word)

  it('每段都在表里 → 放行', () => {
    expect(isHyphenatedAllowed('part-time', allow)).toBe(true)
    expect(isHyphenatedAllowed('sixty-year-old', allow)).toBe(true)
  })

  it('有一段不在表里 → 不放行', () => {
    expect(isHyphenatedAllowed('part-place', allow)).toBe(false)
  })

  it('单字母段不放行（x-ray 不能靠 x 混过去）', () => {
    expect(isHyphenatedAllowed('x-ray', () => true)).toBe(false)
  })
})

describe('validateArticle · W1 三例假违规清零', () => {
  it('larger：原形 large 在表里就合法', () => {
    const { valid, unknownWords } = validate('His house is larger than mine.', [
      'his',
      'house',
      'is',
      'large',
      'than',
      'mine',
    ])

    expect(unknownWords).toEqual([])
    expect(valid).toBe(true)
  })

  it('part-time：连字符拆段后每段在表里', () => {
    const { valid } = validate('Part-time work is good.', ['part', 'time', 'work', 'is', 'good'])
    expect(valid).toBe(true)
  })

  it('sixty-year-old：三段都在表里', () => {
    const { valid } = validate('He is sixty-year-old now.', [
      'he',
      'is',
      'sixty',
      'year',
      'old',
      'now',
    ])
    expect(valid).toBe(true)
  })

  it('cone-shaped：shaped 依赖 shape 的变形闭包', () => {
    const { valid } = validate('A cone-shaped hat is here.', [
      'a',
      'cone',
      'shape',
      'hat',
      'is',
      'here',
    ])
    expect(valid).toBe(true)
  })

  it('反例：business 仍然违规', () => {
    const { valid, unknownWords } = validate('This business is big.', [
      'this',
      'is',
      'big',
    ])

    expect(valid).toBe(false)
    expect(unknownWords).toContain('business')
  })

  it('反例：有一段不在表里的连字符词仍然违规，且不算 wordform', () => {
    const { valid, violations } = validate('A sixty-year-oldx man came.', [
      'a',
      'man',
      'came',
    ])

    expect(valid).toBe(false)
    const violation = violations.find((item) => item.normalized === 'sixty-year-oldx')
    expect(violation).toBeTruthy()
    expect(violation.category).not.toBe('wordform')
  })

  it('反例：单字母段的连字符词不被放行', () => {
    const { valid, unknownWords } = validate('X-ray is here.', ['is', 'here'])
    expect(valid).toBe(false)
    expect(unknownWords).toContain('x-ray')
  })
})
