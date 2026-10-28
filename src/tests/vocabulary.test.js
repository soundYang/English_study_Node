import { describe, expect, it } from 'vitest'

import { basicWords } from '../modules/readings/basic-words.js'
import { calendarWords } from '../modules/readings/calendar-words.js'
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

  it('易漏的不规则过去分词：shown / sunk / rang', () => {
    expect(check('shown', ['show']).valid).toBe(true)
    expect(check('sunk', ['sink']).valid).toBe(true)
    expect(check('rang', ['ring']).valid).toBe(true)
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

  it('cannot 是被连写的 can not，不当生词（实测必踩）', () => {
    expect(check('I cannot go.', ['i', 'can', 'not', 'go']).valid).toBe(true)

    // 展开后仍然逐项校验：缺 not 就报 not
    expect(check('I cannot go.', ['i', 'can', 'go']).unknownWords).toEqual(['not'])
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
      {
        token: 'quizzical',
        normalized: 'quizzical',
        category: 'unknown_token',
        sentence: 'The dog quizzical.',
      },
    ])
  })

  it('空文章合法且计数为 0', () => {
    expect(check('', ['the'])).toEqual({
      valid: true,
      unknownWords: [],
      checkedWordCount: 0,
      violations: [],
      counts: {
        abbreviation: 0,
        proper_noun: 0,
        wordform: 0,
        missing_common: 0,
        rare: 0,
        unknown_token: 0,
      },
      detectedNames: [],
    })
  })
})

describe('validateArticle · 违规词分类', () => {
  /** 只取「词 → 分类」，句子和原 token 单独在下面的用例里验 */
  const categoriesOf = (article, allowedWords, names = []) =>
    validateArticle({ article, allowedWords, names }).violations.map(
      ({ normalized, category }) => [normalized, category],
    )

  it('COCA 前 3000 的常用词 → missing_common（实测 800 词那批全都落在这里）', () => {
    const article =
      'The business was simple and serious, and the depth was similar to the volunteer.'

    expect(categoriesOf(article, ['the', 'was', 'and', 'to'])).toEqual([
      ['business', 'missing_common'],
      ['simple', 'missing_common'],
      ['serious', 'missing_common'],
      ['depth', 'missing_common'],
      ['similar', 'missing_common'],
      ['volunteer', 'missing_common'],
    ])
  })

  it('有排名但超过 3000 → rare，这类才是真的超纲', () => {
    expect(categoriesOf('Kindness is good.', ['is', 'good'])).toEqual([['kindness', 'rare']])
  })

  it('句首大写不算专名：Quizzical 在句首仍是 unknown_token', () => {
    expect(categoriesOf('Quizzical is good.', ['is', 'good'])).toEqual([
      ['quizzical', 'unknown_token'],
    ])
  })

  it('句中首字母大写 → proper_noun，并记进 detectedNames', () => {
    const result = validateArticle({
      article: 'He met Anna in the hall.',
      allowedWords: ['he', 'met', 'in', 'the', 'hall'],
    })

    expect(result.violations).toEqual([
      {
        token: 'Anna',
        normalized: 'anna',
        category: 'proper_noun',
        sentence: 'He met Anna in the hall.',
      },
    ])
    expect(result.detectedNames).toEqual(['anna'])
  })

  it('点号缩写 → abbreviation，而不是把 U.S. 拆成 us 当生词', () => {
    expect(categoriesOf('The U.S. is big and Dr. Smith came.', ['the', 'is', 'big', 'and', 'came']))
      .toEqual([
        ['us', 'abbreviation'],
        ['dr', 'abbreviation'],
        // Dr. 后面的句点会被当成断句，Smith 因此不判专名——
        // 误判方向是「少认一个名字」，比反过来安全
        ['smith', 'unknown_token'],
      ])
  })

  it('规则还原漏掉的词形 → wordform（lying → lie 是现有实现的真实缺口）', () => {
    // resolveBaseForms('lying') 只给 ly / lye，命中不了 lie
    expect(categoriesOf('He was lying on the bed.', ['he', 'was', 'on', 'the', 'bed', 'lie'])).toEqual(
      [['lying', 'wordform']],
    )
  })

  it('词本身没排名时退到词形：helpers → helper(9110) → rare，而不是 unknown_token', () => {
    // 只看词本身会把所有规则复数都判成"生造词"
    expect(categoriesOf('She had helpers there.', ['she', 'had', 'there'])).toEqual([
      ['helpers', 'rare'],
    ])
  })

  it('连字符词各段都放行 → wordform：切词没拆开，属于校验器的 bug', () => {
    // 实测真实文章里 part(178) + time(52) 都在表内，part-time 却被判违规
    expect(categoriesOf('It was a part-time job.', ['it', 'was', 'a', 'job', 'part', 'time'])).toEqual(
      [['part-time', 'wordform']],
    )
  })

  it('连字符词有一段不在表内 → 仍按排名判，不硬塞进 wordform', () => {
    expect(categoriesOf('It was a part-time job.', ['it', 'was', 'a', 'job', 'time'])).toEqual([
      ['part-time', 'rare'],
    ])
  })

  it('counts 与 violations 一一对应', () => {
    const result = validateArticle({
      article: 'He met Anna. Kindness and business matter.',
      allowedWords: ['he', 'met', 'and', 'matter'],
    })

    expect(Object.keys(result.counts).sort()).toEqual([
      'abbreviation',
      'missing_common',
      'proper_noun',
      'rare',
      'unknown_token',
      'wordform',
    ])
    expect(result.counts).toEqual({
      abbreviation: 0,
      proper_noun: 1,
      wordform: 0,
      missing_common: 1,
      rare: 1,
      unknown_token: 0,
    })
    expect(result.counts.proper_noun + result.counts.missing_common + result.counts.rare).toBe(
      result.violations.length,
    )
  })
})

describe('基础词表', () => {
  it('产出 2578 个词（600 人工 + 按排名补到 rank ≤ 3000），全部是小写纯字母或撇号词', () => {
    // 数字是 §4.2 扩表后的确定值：改词表就该改这一行，正好当「被误覆盖」的哨兵
    expect(basicWords).toHaveLength(2578)
    expect(basicWords.every((word) => /^[a-z]+(?:'[a-z]+)?$/.test(word))).toBe(true)
    expect(new Set(basicWords).size).toBe(basicWords.length)
  })

  it('补齐 COCA 词元表漏掉的虚词（an 漏了会让每篇含 an 的文章失败）', () => {
    // 物主代词 mine / yours / hers / ours / theirs 是功能词，必须常驻
    for (const word of ['an', 'onto', 'mine', 'yours', 'hers', 'ours', 'theirs', 'whom', 'shall']) {
      expect(basicWords.includes(word)).toBe(true)
    }

    // 只用基础词 + an：apple / orange 不在 600 词里，会把用例引偏
    const article = 'Tom has an old book. An hour is a long time.'

    expect(validateArticle({ article, allowedWords: new Set(basicWords), names: ['Tom'] }).valid).toBe(
      true,
    )
  })

  it('不含专有名词、缩写与表头残留', () => {
    for (const word of ['mr', 'tv', 'american', 'congress', 'true', "n't"]) {
      // true 是普通词，必须保留；其余都不该出现
      expect(basicWords.includes(word)).toBe(word === 'true')
    }
  })

  it('一段只用基础词写的文章能通过校验', () => {
    const article =
      'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house.'

    expect(validateArticle({ article, allowedWords: new Set(basicWords), names: ['Tom'] }).valid).toBe(
      true,
    )
  })
})

describe('日历词白名单', () => {
  it('19 个星期与月份，全部小写纯字母', () => {
    expect(calendarWords).toHaveLength(19)
    expect(calendarWords.every((word) => /^[a-z]+$/.test(word))).toBe(true)
  })

  it('这些词在基础词表里捞不到，只能靠白名单放行', () => {
    for (const word of ['saturday', 'december']) {
      expect(basicWords.includes(word)).toBe(false)
    }

    // 正文里是大写（Saturday），校验时统一转小写后再命中白名单
    expect(validateArticle({ article: 'Saturday December', allowedWords: calendarWords }).valid).toBe(
      true,
    )
  })
})
