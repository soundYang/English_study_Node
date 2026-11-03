import { describe, expect, it } from 'vitest'

import {
  checkQuestionQuality,
  checkQuestionWarnings,
  normalizeTranslations,
  validateAiReading,
} from '../modules/readings/ai.schema.js'

/**
 * 题目质量的确定性校验（md/21 W7、md/30 §10-7）。
 *
 * 两条**阻断**规则，只看字符串、不调模型：
 *   evidence 必须真实存在于正文 / 每档的题型配额。
 * 这些校验的价值在于「编出来的题会被当场发现」，而不是再花一次调用去问模型。
 *
 * 「detail 答案要与 evidence 有实词重合」已降级为**警告**（checkQuestionWarnings）：
 * 词面比较分不清同义改写和胡编，长文里误伤率太高，只落 aiMeta 不拦生成。
 */

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. '
  + 'Tom and his book play in the house. They are good friends. '
  + 'Tom likes his book very much.'

const question = (overrides = {}) => ({
  id: 1,
  question: 'What kind of boy is Tom?',
  type: 'detail',
  evidence: 'Tom is a good boy.',
  options: ['A good boy', 'A big book', 'A small house', 'A friend'],
  correctAnswer: 0,
  explanation: '正文第一句。',
  ...overrides,
})

const detailSet = () => [
  question({ id: 1 }),
  question({ id: 2, question: 'How is the book?', evidence: 'His book is big', options: ['big', 'small', 'red', 'new'] }),
  question({ id: 3, question: 'Where do they play?', evidence: 'play in the house', options: ['house', 'car', 'park', 'school'] }),
]

describe('checkQuestionQuality · evidence 必须真实存在', () => {
  it('编造的引文会被指出来，并带上题号', () => {
    const questions = detailSet()
    questions[1] = question({ id: 2, evidence: 'His book is green.' })

    const issue = checkQuestionQuality(questions, ARTICLE, 'easy')

    expect(issue).toContain('第 2 题')
    expect(issue).toContain('evidence')
  })

  it('大小写与弯引号不同不算编造', () => {
    const questions = detailSet()
    questions[0] = question({ evidence: 'TOM IS A GOOD BOY.' })

    expect(checkQuestionQuality(questions, ARTICLE, 'easy')).toBeNull()
  })
})

describe('checkQuestionQuality · 题型配额', () => {
  it('easy 至少 2 道 detail', () => {
    const questions = [
      question({ id: 1 }),
      question({ id: 2, type: 'inference' }),
      question({ id: 3, type: 'paraphrase' }),
    ]

    expect(checkQuestionQuality(questions, ARTICLE, 'easy')).toContain('至少 2 道 detail')
  })

  it('hard 至少 1 道 inference / main_idea', () => {
    const allDetail = detailSet()

    expect(checkQuestionQuality(allDetail, ARTICLE, 'hard')).toContain('inference')
    expect(checkQuestionQuality([...allDetail, question({ id: 4, type: 'main_idea' })], ARTICLE, 'hard'))
      .toBeNull()
  })

  it('medium 不设题型配额', () => {
    const allDetail = detailSet()

    expect(checkQuestionQuality(allDetail, ARTICLE, 'medium')).toBeNull()
  })
})

describe('checkQuestionWarnings · detail 答案与依据的重合度只记警告', () => {
  it('正确答案和 evidence 毫无交集 → 返回一条警告，带题号与代码', () => {
    const questions = detailSet()
    questions[0] = question({ options: ['A blue car', 'A big book', 'A small house', 'A friend'] })

    expect(checkQuestionWarnings(questions)).toEqual([
      expect.objectContaining({ questionId: 1, code: 'detail_answer_overlap' }),
    ])
  })

  it('实词重合达到一半就不警告', () => {
    const questions = detailSet()
    // good + boy 都在 evidence 里
    questions[0] = question({ options: ['A good boy', 'A big book', 'A house', 'A friend'] })

    expect(checkQuestionWarnings(questions)).toEqual([])
  })

  it('词形变化算命中：evidence 里的 repaired 能对上选项的 Repair', () => {
    // 只看小写原词时这两个词零重合，正是长文误判的主要来源
    const questions = [question({ evidence: 'The workers repaired the roof.', options: ['Repair', 'x', 'y', 'z'] })]

    expect(checkQuestionWarnings(questions)).toEqual([])
  })

  it('只检查 detail 题，其他题型不参与', () => {
    const questions = [question({ type: 'inference', options: ['A blue car', 'A big book', 'A small house', 'A friend'] })]

    expect(checkQuestionWarnings(questions)).toEqual([])
  })

  it('选项里全是虚词时跳过（没有实词可比）', () => {
    const questions = [question({ options: ['a', 'the', 'is', 'to'] })]

    expect(checkQuestionWarnings(questions)).toEqual([])
  })

  it('降级后 checkQuestionQuality 不再因为重合不足而拒绝', () => {
    const questions = detailSet()
    questions[0] = question({ options: ['A blue car', 'A big book', 'A small house', 'A friend'] })

    expect(checkQuestionQuality(questions, ARTICLE, 'easy')).toBeNull()
  })
})

describe('validateAiReading · 失败类型的区分', () => {
  const raw = (questions) => ({
    title: 'A Good Day',
    article: ARTICLE,
    translation: '汤姆是个好男孩，他的书很大，他们是非常好的朋友。',
    names: ['Tom'],
    questions,
  })

  it('题目不合格时 kind=questions：调用方可以只重写题目', () => {
    const questions = detailSet()
    questions[1] = question({ id: 2, evidence: 'Tom has a dog.' })

    const result = validateAiReading(raw(questions), { questionCount: 3, level: 'easy' })

    expect(result.ok).toBe(false)
    expect(result.kind).toBe('questions')
  })

  it('结构 / 数量问题不带 kind，按整篇重写处理', () => {
    const result = validateAiReading(raw(detailSet()), { questionCount: 5, level: 'easy' })

    expect(result.ok).toBe(false)
    expect(result.kind).toBeUndefined()
    expect(result.reason).toContain('题目数量')
  })

  it('全部合格时返回解析后的数据，警告为空', () => {
    const result = validateAiReading(raw(detailSet()), { questionCount: 3, level: 'easy' })

    expect(result.ok).toBe(true)
    expect(result.data.questions[0].type).toBe('detail')
    expect(result.warnings).toEqual([])
  })

  it('同义改写的 detail 题不再判失败，只带一条警告', () => {
    // 真实失败样本（md/30 §10-7）：evidence 写 stomach drop，
    // 正确选项是语义等价、词面零重合的 Shocked and deeply disappointed
    const article =
      'Mia studied hard for the maths test all week. She had expected a good mark, '
      + 'but the paper showed a number that made her stomach drop. '
      + 'She walked home slowly and told nobody about it.'
    const questions = [
      {
        id: 1,
        question: 'How did Mia feel when she saw her mark?',
        options: [
          'Shocked and deeply disappointed',
          'Proud of her work',
          'Bored by the lesson',
          'Ready for lunch',
        ],
        correctAnswer: 0,
        type: 'detail',
        evidence: 'the paper showed a number that made her stomach drop',
        explanation: '胃一沉说明她看到分数时非常震惊、失望。',
      },
      {
        id: 2,
        question: 'How did Mia go home?',
        options: ['Walked home slowly', 'Ran home quickly', 'Took a bus', 'Stayed at school'],
        correctAnswer: 0,
        type: 'detail',
        evidence: 'She walked home slowly',
        explanation: '原文写她慢慢走回家。',
      },
      {
        id: 3,
        question: 'How long did Mia study?',
        options: ['Studied hard all week', 'Studied one night', 'Never studied', 'Studied at school only'],
        correctAnswer: 0,
        type: 'detail',
        evidence: 'Mia studied hard for the maths test all week',
        explanation: '原文写她整周都在努力复习。',
      },
    ]

    const result = validateAiReading(
      { title: 'A Hard Test', article, translation: '米娅为数学考试努力复习了一整周，看到分数时非常震惊。', names: [], questions },
      { questionCount: 3, level: 'easy' },
    )

    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([
      expect.objectContaining({ questionId: 1, code: 'detail_answer_overlap' }),
    ])
  })
})

describe('normalizeTranslations · 逐段翻译对齐', () => {
  const article = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'

  it('translations 条数等于段落数时直接采用，并拼出整篇 translation', () => {
    const result = normalizeTranslations({
      article,
      translations: ['第一段。', '第二段。', '第三段。'],
    })

    expect(result).toEqual({
      translation: '第一段。\n\n第二段。\n\n第三段。',
      translations: ['第一段。', '第二段。', '第三段。'],
    })
  })

  it('只有整篇 translation 时按空行拆开', () => {
    const result = normalizeTranslations({
      article,
      translation: '第一段。\n\n第二段。\n\n第三段。',
    })

    expect(result.translations).toEqual(['第一段。', '第二段。', '第三段。'])
    expect(result.translation).toBe('第一段。\n\n第二段。\n\n第三段。')
  })

  it('段数对不上时保留整篇翻译，translations 回空，不硬拆句子', () => {
    const result = normalizeTranslations({
      article,
      translation: '一整段没有分行的翻译。',
    })

    expect(result.translation).toBe('一整段没有分行的翻译。')
    expect(result.translations).toEqual([])
  })

  it('只有 translations 且条数对不上：拼成整篇保留，不让整篇生成失败', () => {
    const result = normalizeTranslations({ article, translations: ['第一段。', '第二段加第三段。'] })

    expect(result.translation).toBe('第一段。\n\n第二段加第三段。')
    expect(result.translations).toEqual([])
  })

  it('两种翻译都没有 → null', () => {
    expect(normalizeTranslations({ article })).toBeNull()
    expect(normalizeTranslations({ article, translations: [] })).toBeNull()
  })

  it('validateAiReading 接受只返回 translations 的新格式', () => {
    const result = validateAiReading(
      {
        title: 'A Good Day',
        article: ARTICLE,
        translations: ['汤姆是个好男孩，他的书很大，他们是非常好的朋友。'],
        names: ['Tom'],
        questions: detailSet(),
      },
      { questionCount: 3, level: 'easy' },
    )

    expect(result.ok).toBe(true)
    expect(result.data.translation).toBe('汤姆是个好男孩，他的书很大，他们是非常好的朋友。')
    expect(result.data.translations).toEqual(['汤姆是个好男孩，他的书很大，他们是非常好的朋友。'])
  })
})
