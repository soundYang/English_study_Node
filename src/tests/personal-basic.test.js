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

function makePayload() {
  return {
    title: 'A Good Day',
    article: ARTICLE,
    translation:
      '汤姆是个好男孩。他的书很大，男孩很小。汤姆和他的书在房子里玩，他们是非常好的朋友。',
    names: ['Tom'],
    questions: [1, 2, 3].map((id) => ({
      id,
      question: `Question number ${id} about the story?`,
      options: ['a', 'b', 'c', 'd'],
      correctAnswer: id - 1,
      explanation: '根据文章内容可知。',
    })),
  }
}

const reply = (payload) => ({
  content: JSON.stringify(payload),
  usage: { prompt_tokens: 100, completion_tokens: 200 },
})

function seedWords(count = 29) {
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
    chatJson.mockResolvedValue(reply(makePayload()))

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

  it('难度决定基础词表：hard 请求拿到 2578 词的完整表', async () => {
    await seedWords()
    chatJson.mockResolvedValue(reply(makePayload()))

    const res = await generate({ level: 'hard', targetWords: 100, questionCount: 3 })

    expect(res.status).toBe(201)
    expect(basicSectionOf(chatJson.mock.calls[0])).toContain(
      `【基础词】共 ${basicWordsByLevel.hard.length} 个`,
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
