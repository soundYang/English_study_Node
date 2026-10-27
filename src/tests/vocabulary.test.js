import { describe, expect, it } from 'vitest'

import { basicWords } from '../modules/readings/basic-words.js'
import { validateArticle } from '../modules/readings/vocabulary.service.js'

/**
 * 词汇校验是"错了没人看得出来"的模块：
 * 它漏词不会报错，只会悄悄生成一篇满篇生词的文章。
 * 所以这里逐个覆盖分词、改写、还原的每一种情况。
 */
const check = (article, allowedWords, names = []) =>
  validateArticle({ article, allowedWords, names })

describe('validateArticle · 词形还原', () => {
  it('规则复数与过去式：stories / played / running', () => {
    const result = check('Stories played running.', ['story', 'play', 'run'])

    expect(result.valid).toBe(true)
    expect(result.unknownWords).toEqual([])
  })

  it('不规则变化：went → go、children → child', () => {
    const result = check('went children', ['go', 'child'])

    expect(result.valid).toBe(true)
  })

  it('两字母的不规则形式：is → be（长度门槛不能先于不规则表）', () => {
    expect(check('is', ['be']).valid).toBe(true)
    expect(check('am', ['be']).valid).toBe(true)
  })

  it('第三人称单数：likes → like、goes → go', () => {
    expect(check('likes goes', ['like', 'go']).valid).toBe(true)
  })

  it('比较级与最高级：bigger → big、happiest → happy', () => {
    expect(check('bigger happiest', ['big', 'happy']).valid).toBe(true)
  })

  it('副词：quickly → quick', () => {
    expect(check('quickly', ['quick']).valid).toBe(true)
  })
})

describe('validateArticle · 缩写与所有格', () => {
  it("don't 展开成 do not 后逐项校验", () => {
    expect(check("I don't know.", ['i', 'do', 'not', 'know']).valid).toBe(true)
  })

  it('展开后缺词就报缺的那个词，而不是报缩写本身', () => {
    const result = check("I don't know.", ['i', 'do', 'know'])

    expect(result.valid).toBe(false)
    expect(result.unknownWords).toEqual(['not'])
  })

  it('弯引号与直引号等价', () => {
    expect(check('it’s fine', ['it', 'is', 'fine']).valid).toBe(true)
    expect(check("it's fine", ['it', 'is', 'fine']).valid).toBe(true)
  })

  it("所有格 Tom's → tom", () => {
    expect(check("Tom's dog", ['tom', 'dog']).valid).toBe(true)
  })

  it('复数所有格的撇号被切掉，仍按词根校验', () => {
    expect(check('dogs’', ['dog']).valid).toBe(true)
  })
})

describe('validateArticle · 人名与大小写', () => {
  it('声明过的人名放行，且不区分大小写', () => {
    expect(check('Lina met lina.', ['met'], ['Lina']).valid).toBe(true)
  })

  it('人名里的所有格也放行', () => {
    expect(check("Lina's dog", ['dog'], ['Lina']).valid).toBe(true)
  })

  it('句首大写不等于专有名词：The 不在表里照样报错', () => {
    const result = check('The dog', ['dog'], ['Lina'])

    expect(result.valid).toBe(false)
    expect(result.unknownWords).toEqual(['the'])
  })

  it('allowedWords 传大写也能匹配', () => {
    expect(check('the dog', ['The', 'Dog']).valid).toBe(true)
  })
})

describe('validateArticle · 判定与统计', () => {
  it('有一个生词就整体不合法（不做容忍比例）', () => {
    const result = check('the dog quizzical', ['the', 'dog'])

    expect(result.valid).toBe(false)
    expect(result.unknownWords).toEqual(['quizzical'])
  })

  it('生词去重后按出现顺序返回', () => {
    const result = check('zzz aaa zzz aaa', ['the'])

    expect(result.unknownWords).toEqual(['zzz', 'aaa'])
  })

  it('checkedWordCount 按展开后的词计，缩写算两个词', () => {
    expect(check("I don't know", ['i', 'do', 'not', 'know']).checkedWordCount).toBe(4)
  })

  it('violations 带上违规词所在的原句，供修正轮局部改写', () => {
    const result = check('The dog quizzical. The cat slept.', ['the', 'dog', 'cat', 'slept'])

    expect(result.violations).toEqual([
      { word: 'quizzical', sentence: 'The dog quizzical.' },
    ])
  })

  it('空文章合法且计数为 0', () => {
    expect(check('', ['the'])).toEqual({
      valid: true,
      unknownWords: [],
      checkedWordCount: 0,
      violations: [],
    })
  })
})

describe('基础词表', () => {
  it('产出 728 个词，全部是小写纯字母或撇号词', () => {
    expect(basicWords).toHaveLength(728)
    expect(basicWords.every((word) => /^[a-z]+(?:'[a-z]+)?$/.test(word))).toBe(true)
  })

  it('不含专有名词、缩写与表头残留', () => {
    for (const word of ['mr', 'tv', 'american', 'congress', 'true', "n't"]) {
      // true 是普通词，必须保留；其余都不该出现
      expect(basicWords.includes(word)).toBe(word === 'true')
    }
  })

  it('一段只用基础词写的文章能通过校验', () => {
    const article =
      'Tom is a good boy. His dog is big and the boy is small. Tom and his dog play in the house.'

    expect(validateArticle({ article, allowedWords: new Set(basicWords), names: ['Tom'] }).valid).toBe(
      true,
    )
  })
})
