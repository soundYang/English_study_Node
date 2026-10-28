import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 个人基础词（md/21 W2）。
 *
 * 派生规则：个人基础词 = 该难度基础表 − 用户标记为 new 的词。
 * 179 个功能词不参与减法——否则用户把 the 标成 new 就锁死整个系统。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { basicWordsByLevel } = await import('../modules/readings/basic-words.js')
const { basicWordsVersions } = await import('../modules/readings/versions.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

/**
 * 不含 book 的同一篇正文。
 * 用户把 book 标成 new 之后，easy 的生词预算是 0——
 * 模型必须换一个基础词重写，否则这篇正文永远过不了校验。
 * car / friend / like / run / play 都在 easy 600 内，friends / likes / runs 由词形闭包放行。
 */
const ARTICLE_WITHOUT_BOOK =
  'Tom is a good boy. His car is big and the boy is small. Tom and his car play in the house. The car runs and the boy runs too. They are good friends. Tom likes his car very much.'

function makePayload(article = ARTICLE, level = 'easy') {
  return {
    title: 'A Good Day',
    article,
    translation:
      '汤姆是个好男孩。他的车很大，男孩很小。汤姆和他的车在房子里玩，他们是非常好的朋友。',
    names: ['Tom'],
    // W7：evidence 必须是正文里的句子（两篇正文都含这一句），
    // detail 题的正确答案 good 与 evidence 有实词重合；hard 需要一道推断题
    questions: [1, 2, 3].map((id) => ({
      id,
      question: `Question number ${id} about the story?`,
      type: level === 'hard' && id === 3 ? 'inference' : 'detail',
      evidence: 'Tom is a good boy.',
      options: ['good', 'big', 'small', 'house'],
      correctAnswer: 0,
      explanation: '根据文章内容可知。',
    })),
  }
}

const reply = (payload) => ({
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

/**
 * easy 的已知词门是 1000（600 基础词 + 个人词，md/20 定的个人下限是 400），
 * 所以默认播 400 个；hard 的门槛 3778 需要约 1200 个个人词，那条用例单独播。
 */
function seedWords(count = 400) {
  return Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )
}

const markNew = (word) =>
  Word.create({
    userId: config.defaultUserId,
    word,
    status: 'new',
    source: 'basic-removed',
    senses: [{ pos: '', meaning: '用户不认识' }],
  })

const generate = (body) =>
  request(app).post('/api/readings/generate').send(body)

const basicSectionOf = (call) => {
  const prompt = call[0].messages[1].content
  return prompt.slice(prompt.indexOf('【基础词】'))
}

beforeEach(() => {
  chatJson.mockReset()
})

describe('个人基础词 · 生成链路', () => {
  it('用户把 book 标成 new → easy 档基础词少一个，提示词里不再出现 book', async () => {
    await seedWords()
    await markNew('book')
    chatJson.mockResolvedValue(reply(makePayload(ARTICLE_WITHOUT_BOOK)))

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const section = basicSectionOf(chatJson.mock.calls[0])
    expect(section).toContain(`【基础词】共 ${basicWordsByLevel.easy.length - 1} 个`)
    expect(section).not.toMatch(/\bbook\b/)
  })

  it('用户把 the 标成 new → 不生效，生成照常成功', async () => {
    await seedWords()
    await markNew('the')
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const section = basicSectionOf(chatJson.mock.calls[0])
    expect(section).toContain(`【基础词】共 ${basicWordsByLevel.easy.length} 个`)
    expect(section).toMatch(/\bthe\b/)
  })

  it('基础词表不再随难度变化：hard 请求拿到的仍是 easy 那 600 个', async () => {
    // 2026-10-28 产品决定：基础词汇只有 600 多个，三档共用同一份。
    // hard 的已知词门 3778 依旧不变，所以个人词库得自己补到 3159 个左右。
    await seedWords(3200)
    chatJson.mockResolvedValue(reply(makePayload(ARTICLE, 'hard')))

    const res = await generate({ level: 'hard', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)
    expect(basicSectionOf(chatJson.mock.calls[0])).toContain(
      `【基础词】共 ${basicWordsByLevel.easy.length} 个`,
    )
  })

  it('aiMeta 记录本次实际使用的档位与版本', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate({ level: 'easy', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)

    const { Reading } = await import('../modules/readings/reading.model.js')
    const doc = await Reading.findById(res.body.id).lean()

    expect(doc.aiMeta.basicWordsLevel).toBe('easy')
    expect(doc.aiMeta.basicWordsVersion).toBe(basicWordsVersions.easy)
  })
})
