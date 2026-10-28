import { describe, expect, it } from 'vitest'

import { checkQuestionQuality, validateAiReading } from '../modules/readings/ai.schema.js'

/**
 * 题目质量的确定性校验（md/21 W7）。
 *
 * 三条规则，全部只看字符串，不调模型：
 *   evidence 必须真实存在于正文 / 每档的题型配额 / detail 的答案要与 evidence 有实词重合。
 * 这些校验的价值在于「编出来的题会被当场发现」，而不是再花一次调用去问模型。
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

describe('checkQuestionQuality · detail 的答案要与依据相关', () => {
  it('正确答案和 evidence 毫无交集 → 指出来', () => {
    const questions = detailSet()
    questions[0] = question({ options: ['A blue car', 'A big book', 'A small house', 'A friend'] })

    expect(checkQuestionQuality(questions, ARTICLE, 'easy')).toContain('几乎无关')
  })

  it('实词重合达到一半就放行', () => {
    const questions = detailSet()
    // good + boy 都在 evidence 里
    questions[0] = question({ options: ['A good boy', 'A big book', 'A house', 'A friend'] })

    expect(checkQuestionQuality(questions, ARTICLE, 'easy')).toBeNull()
  })

  it('选项里全是虚词时跳过重合度检查（单字母选项不参与）', () => {
    const questions = detailSet()
    questions[0] = question({ options: ['a', 'b', 'c', 'd'] })

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

  it('全部合格时返回解析后的数据', () => {
    const result = validateAiReading(raw(detailSet()), { questionCount: 3, level: 'easy' })

    expect(result.ok).toBe(true)
    expect(result.data.questions[0].type).toBe('detail')
  })
})
