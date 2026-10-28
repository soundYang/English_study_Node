import { describe, expect, it } from 'vitest'

import { buildMessages, buildRepairMessages } from '../modules/readings/ai.prompt.js'

const build = (extra = {}) =>
  buildMessages({
    level: 'hard',
    targetWords: 300,
    questionCount: 5,
    focusWords: ['story', 'garden'],
    targetWordList: ['borrow', 'able'],
    supportWords: ['apple', 'zoo'],
    basicWords: ['a', 'the'],
    ...extra,
  })

/** 用户消息是第二条，系统提示词是第一条 */
const userMessage = (messages) => messages[1].content

describe('buildMessages · 三段式词表', () => {
  it('目标词数量是重点词与普通目标词之和', () => {
    expect(userMessage(build())).toContain('【目标词】共 4 个')
  })

  it('重点词带 ★ 前缀，并写回复现次数', () => {
    const prompt = userMessage(build())

    expect(prompt).toContain('★ story ★ garden')
    expect(prompt).toContain('各出现 2–3 次')
    expect(prompt).toContain('其余 2 个各出现 1–2 次')
  })

  it('补充可用词与基础词各自成段，数量准确', () => {
    const prompt = userMessage(build())

    expect(prompt).toContain('【补充可用词】共 2 个')
    expect(prompt).toContain('【基础词】共 2 个')
    // 基础词按字母分组压缩
    expect(prompt).toContain('a: a')
  })

  it('没有重点词时不出现星号', () => {
    const prompt = userMessage(build({ focusWords: [] }))

    expect(prompt).not.toContain('★')
    expect(prompt).toContain('【目标词】共 2 个')
  })

  it('某一段为空时整段省略，不留空标题', () => {
    const prompt = userMessage(
      build({ focusWords: [], targetWordList: [], supportWords: [], basicWords: [] }),
    )

    expect(prompt).not.toContain('【目标词】')
    expect(prompt).not.toContain('【补充可用词】')
    expect(prompt).not.toContain('【基础词】')
  })

  it('系统提示词把三份清单写进规则', () => {
    const system = build()[0].content

    expect(system).toContain('【目标词】')
    expect(system).toContain('【补充可用词】')
    expect(system).toContain('【基础词】')
  })
})

describe('buildRepairMessages', () => {
  const base = build()

  it('默认只追加一条修正指令，不带 assistant 消息', () => {
    const repaired = buildRepairMessages(base, { reason: '结构不对' })

    expect(repaired).toHaveLength(base.length + 1)
    expect(repaired.at(-1).role).toBe('user')
    expect(repaired.at(-1).content).toContain('结构不对')
  })

  it('给了上一轮正文时，作为 assistant 消息插在修正指令之前', () => {
    const repaired = buildRepairMessages(base, { reason: '用了表外词' }, '上一轮的正文')

    const assistant = repaired.find((item) => item.role === 'assistant')
    expect(assistant.content).toBe('上一轮的正文')
    expect(repaired.at(-2)).toBe(assistant)
    expect(repaired.at(-1).role).toBe('user')
  })

  it('违规词最多列 8 条，并附上原句片段', () => {
    const violations = Array.from({ length: 12 }, (_, index) => ({
      word: `bad${index}`,
      sentence: `This sentence contains bad${index} in it.`,
    }))

    const repaired = buildRepairMessages(base, { reason: '出现表外词', violations })
    const content = repaired.at(-1).content

    expect(content).toContain('bad0')
    expect(content).toContain('bad7')
    expect(content).not.toContain('bad8')
  })
})
