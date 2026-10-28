import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 最终模式（md/30 §2.2、§7.3）。
 *
 * 规则：`hard + targetWords > 600 + 个人词库 ≥ 3000`。
 * 它跳过目标词选择、覆盖度检查与 A 门，只保留篇幅校验（±15%）。
 *
 * 测试要守的两件事：
 *   1. 解锁前后的分界是 3000 个**个人词**（不是 knownWords），2999 必须 400；
 *   2. 最终模式真的「没有目标词」——提示词里不能还剩一条「必须全部出现」的规则，
 *      否则模型会去找一份不存在的清单，开始复读某个词凑数。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { logger } = await import('../shared/logger.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')

const app = createApp()

/** 只用基础词 + 声明的人名，过得了词汇校验 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const payload = {
  title: 'A Good Day',
  article: ARTICLE,
  translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
  names: ['Tom'],
  questions: Array.from({ length: 3 }, (_, index) => ({
    id: index + 1,
    question: `Question number ${index + 1} about the story?`,
    type: index === 2 ? 'inference' : 'detail',
    evidence: 'Tom is a good boy.',
    options: ['Tom', 'book', 'house', 'friends'],
    correctAnswer: 0,
    explanation: '根据文章内容可知。',
  })),
}

const reply = { content: JSON.stringify(payload), usage: { prompt_tokens: 100, completion_tokens: 200 } }

const seedWords = (count) =>
  Word.insertMany(
    Array.from({ length: count }, (_, index) => ({
      userId: config.defaultUserId,
      word: `word${index}`,
      status: 'learning',
      source: 'manual',
      senses: [{ pos: '', meaning: '测试释义' }],
    })),
  )

const generate = (body) => request(app).post('/api/readings/generate').send(body)

beforeEach(() => {
  chatJson.mockReset()
})

describe('最终模式 · 解锁', () => {
  it('个人词库 2999 写 700 词 → 400 final_mode_locked，不调模型', async () => {
    await seedWords(2999)

    const res = await generate({ level: 'hard', targetWords: 700, questionCount: 3 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(res.body.error.details).toMatchObject({
      kind: 'final_mode_locked',
      metric: 'personal_words',
      unlockAt: 3000,
      available: 2999,
      shortage: 1,
    })
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('3000 个词写 700 词 → 201，且真的不挑目标词', async () => {
    await seedWords(3000)
    chatJson.mockResolvedValue(reply)

    const res = await generate({ level: 'hard', targetWords: 700, questionCount: 3 })

    expect(res.status).toBe(201)

    const doc = await Reading.findById(res.body.id).lean()

    expect(doc.aiMeta.finalMode).toBe(true)
    expect(doc.aiMeta.personalWords).toBe(3000)
    // 最终模式不查已知词门槛：这个数落 0 而不是 3618
    expect(doc.aiMeta.minKnown).toBe(0)
    expect(doc.aiMeta.knownWords).toBe(3000 + 618)

    // 没有目标词：requiredWords = 0，三个列表全空
    expect(doc.targetPlan.requiredWords).toBe(0)
    expect(doc.targetPlan.focusWords).toEqual([])
    expect(doc.aiMeta.requiredWords).toBe(0)

    // 覆盖度按 0/0 的约定是 0，且不能因此被当成「目标词没写进去」
    expect(doc.aiMeta.targetUsage.coverageRate).toBe(0)
    expect(doc.aiMeta.targetUsage.unused).toEqual([])
  })

  it('最终模式的提示词不再要求「目标词必须全部出现」', async () => {
    await seedWords(3000)
    chatJson.mockResolvedValue(reply)

    await generate({ level: 'hard', targetWords: 700, questionCount: 3 })

    const system = chatJson.mock.calls[0][0].messages[0].content
    const user = chatJson.mock.calls[0][0].messages[1].content

    expect(system).toContain('本次没有指定的目标词')
    expect(system).not.toContain('必须全部出现在正文中')
    // 词表还在（只是从「目标词」降级成「可用词」），否则模型只能写基础 600 词
    expect(user).toContain('【补充可用词】')
    expect(user).not.toContain('【目标词】')
  })

  it('覆盖度只有 0 不会刷 warn：最终模式没有分母', async () => {
    await seedWords(3000)
    chatJson.mockResolvedValue(reply)
    const warn = vi.spyOn(logger, 'warn')

    await generate({ level: 'hard', targetWords: 700, questionCount: 3 })

    const coverageWarns = warn.mock.calls.filter(
      ([, message]) => message === 'target coverage below threshold (warn only, md/21 W5)',
    )
    expect(coverageWarns).toHaveLength(0)

    warn.mockRestore()
  })
})

describe('最终模式只对 hard 开', () => {
  it('easy / medium 即便个人词库 5000 也还是档位上限', async () => {
    await seedWords(5000)
    chatJson.mockResolvedValue(reply)

    const easy = await generate({ level: 'easy', targetWords: 700, questionCount: 3 })
    expect(easy.status).toBe(400)
    expect(easy.body.error.details).toMatchObject({
      kind: 'target_words_cap',
      maxTargetWords: 300,
      finalModeUnlocked: false,
    })

    const medium = await generate({ level: 'medium', targetWords: 700, questionCount: 3 })
    expect(medium.status).toBe(400)
    expect(medium.body.error.details).toMatchObject({
      kind: 'target_words_cap',
      maxTargetWords: 450,
    })
    expect(chatJson).not.toHaveBeenCalled()
  })
})

describe('/capacity 的解锁状态', () => {
  const capacity = (query) => request(app).get('/api/readings/capacity').query(query)

  it('未解锁：顶层 finalMode 给出还差多少，hard 的 700+ 阶梯标 final_mode', async () => {
    await seedWords(400)

    const res = await capacity({ targetWords: 200 })

    expect(res.body.finalMode).toEqual({
      unlocked: false,
      unlockAt: 3000,
      shortage: 2600,
      maxTargetWords: 1000,
    })
    expect(res.body.levels.hard.lengths[6]).toMatchObject({
      targetWords: 700,
      blockedBy: 'final_mode',
      shortage: 2600,
    })
  })

  it('已解锁：hard 三档上限变为 1000，阶梯全亮，finalMode.active 只在 601+ 为真', async () => {
    await seedWords(3000)

    const res = await capacity({ targetWords: 700 })

    expect(res.body.finalMode.unlocked).toBe(true)
    expect(res.body.finalMode.shortage).toBe(0)
    expect(res.body.levels.hard.maxTargetWords).toBe(1000)
    expect(res.body.levels.hard.targetWordsAllowed).toBe(true)
    // 700 词这次请求就是最终模式：没有目标词，A 门不存在
    expect(res.body.levels.hard.finalMode.active).toBe(true)
    expect(res.body.levels.hard.required).toBe(0)
    expect(res.body.levels.hard.sufficient).toBe(true)
    expect(res.body.levels.hard.lengths.every((row) => row.unlocked)).toBe(true)

    // easy 的阶梯不跟着变：它的上限还是 300
    const wide = await capacity({ targetWords: 200 })
    expect(wide.body.levels.easy.maxTargetWords).toBe(300)
    expect(wide.body.levels.easy.finalMode.supported).toBe(false)
  })
})
