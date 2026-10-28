import { describe, expect, it } from 'vitest'

import {
  buildFinishMessages,
  buildMessages,
  buildRepairMessages,
  buildSegmentedSystem,
} from '../modules/readings/ai.prompt.js'

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

/** 违规词条目，字段与 validateArticle() 的输出一致 */
const violation = (word, sentence) => ({
  token: word,
  normalized: word,
  category: 'unknown_token',
  sentence,
})

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

  it('篇幅写成绝对区间，不再是「±5%」', () => {
    const system = build()[0].content
    const prompt = userMessage(build())

    // targetWords 300 → 目标 330、提示词上限 330（重写上界才是 345，md/30 §6-1）
    expect(system).toContain('300–330 个英文单词')
    expect(system).not.toContain('5%')
    expect(prompt).toContain('300–330 词')
  })

  it('首轮就给出句子预算（模型数不清词，但数得清句子）', () => {
    const system = build()[0].content
    const prompt = userMessage(build())

    // W7：hard 每句基准 19 词 → 330 ÷ 19 ≈ 17 句；每句词数由目标值反推
    expect(system).toContain('共 16–18 个句子，每句 19 个英文单词')
    expect(prompt).toContain('约 17 句，每句 19 词')
  })

  it('每句基准词数按难度取：easy 句子更短、句数更多', () => {
    const easy = build({ level: 'easy' })
    const hard = build({ level: 'hard' })

    // easy 12 词/句 → 330 ÷ 12 ≈ 28 句；hard 19 词/句 → 17 句
    expect(userMessage(easy)).toContain('约 28 句')
    expect(userMessage(hard)).toContain('约 17 句')
  })

  it('题目规则里写明 type 与 evidence，并按难度给题型配额', () => {
    const easy = build({ level: 'easy' })[0].content
    const hard = build({ level: 'hard' })[0].content

    expect(easy).toContain('type')
    expect(easy).toContain('evidence')
    expect(easy).toContain('至少 2 道 detail')
    expect(hard).toContain('至少 1 道 inference 或 main_idea')
    // 用户消息里的 JSON 示例同样带上新字段，否则模型不知道字段名
    expect(userMessage(build())).toContain('"evidence"')
  })
})

describe('分段路径提示词', () => {
  it('分段写作也给出本难度的每句词数基准', () => {
    const easy = buildSegmentedSystem({ level: 'easy', targetWords: 300 })
    const hard = buildSegmentedSystem({ level: 'hard', targetWords: 300 })

    expect(easy).toContain('每句约 12 个英文单词')
    expect(hard).toContain('每句约 19 个英文单词')
  })

  it('分段 system 里写明 type / evidence 与题型配额', () => {
    const hard = buildSegmentedSystem({ level: 'hard', targetWords: 300 })

    expect(hard).toContain('evidence')
    expect(hard).toContain('至少 1 道 inference 或 main_idea')
  })

  it('收尾任务要求 evidence 从正文原样复制', () => {
    const finish = buildFinishMessages('system', {
      article: 'Tom is a good boy.',
      questionCount: 3,
      paragraphCount: 1,
      level: 'easy',
    })
    const content = finish.at(-1).content

    expect(content).toContain('"evidence"')
    expect(content).toContain('原样复制')
    expect(content).toContain('至少 2 道 detail')
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

  it('word_count 反馈生成「按句子预算重写」的指令', () => {
    const repaired = buildRepairMessages(base, {
      type: 'word_count',
      reason: '正文有 429 个英文单词，超过上限 345',
      range: { min: 300, max: 345, target: 330 },
    })
    const content = repaired.at(-1).content

    // 330 词 ÷ 每句 15 词 ≈ 22 句，±1
    expect(content).toContain('共 21–23 个英文句子')
    expect(content).toContain('每句 15 个英文单词')
    expect(content).toContain('全文目标约 330 词，必须落在 300–345 词之间')
    expect(content).toContain('重新写一篇文章')
    // 重写会重编情节，必须当场重申用词边界（实测曾带出 14 个表外词）
    expect(content).toContain('不要引入表外词')
    // 篇幅修正不该再重复「表外词」那套话术
    expect(content).not.toContain('不在允许词表中')
  })

  it('word_count 不把上一篇正文放回上下文（锚定只会让模型挤牙膏）', () => {
    const repaired = buildRepairMessages(
      base,
      { type: 'word_count', reason: '正文超过上限', range: { min: 300, max: 345, target: 330 } },
      '上一轮那篇过长的正文',
    )

    expect(repaired.some((item) => item.role === 'assistant')).toBe(false)
    expect(repaired.at(-1).role).toBe('user')
  })

  it('没有 range 时 word_count 仍能给出可执行的指令', () => {
    const repaired = buildRepairMessages(base, { type: 'word_count', reason: '正文超过上限' })
    const content = repaired.at(-1).content

    expect(content).toContain('重新写一篇文章')
    expect(content).not.toContain('每句')
  })

  it('questions 反馈只重写题目，正文原样保留', () => {
    const repaired = buildRepairMessages(
      base,
      { type: 'questions', reason: '第 2 题的 evidence 在正文里找不到' },
      '{"title":"…","article":"…"}',
      'easy',
    )
    const content = repaired.at(-1).content

    expect(content).toContain('只重写 questions')
    expect(content).toContain('title、article、translation 与 names 完全不变')
    // 配额口径跟难度走
    expect(content).toContain('至少 2 道 detail')
    // 题目是改在上一轮输出上的，必须把它放回上下文
    expect(repaired.some((item) => item.role === 'assistant')).toBe(true)
  })

  it('用词反馈会重申字数区间，防止越修越长', () => {
    const repaired = buildRepairMessages(
      base,
      { type: 'vocabulary', reason: '出现表外词', range: { min: 300, max: 345, target: 330 } },
    )

    expect(repaired.at(-1).content).toContain('300–345')
  })

  it('违规词全量列出，原句只给前 8 条', () => {
    const violations = Array.from({ length: 12 }, (_, index) =>
      violation(`bad${index}`, `This sentence contains bad${index} in it.`),
    )

    const repaired = buildRepairMessages(base, { type: 'vocabulary', reason: '出现表外词', violations })
    const content = repaired.at(-1).content

    // 词表全给：19 / 59 个违规时只列 8 个是收敛慢的主因
    expect(content).toContain('共 12 个')
    expect(content).toContain('bad11')
    // 原句只给前 8 条，避免把修正轮的 token 预算吃掉
    expect(content.match(/^- "bad\d+"/gm)).toHaveLength(8)
  })

  it('违规超过 8 个时改成全文重写，而不是逐句替换', () => {
    const violations = Array.from({ length: 12 }, (_, index) =>
      violation(`bad${index}`, `Sentence ${index}.`),
    )

    const content = buildRepairMessages(base, {
      type: 'vocabulary',
      reason: '出现表外词',
      violations,
      range: { min: 300, max: 345, target: 330 },
    }).at(-1).content

    expect(content).toContain('把全文重写一遍')
    expect(content).toContain('不要引入任何表外词')
    expect(content).toContain('300–345')
    expect(content).not.toContain('只替换这几处表达')
  })

  it('违规不超过 8 个时仍走局部修正', () => {
    const violations = Array.from({ length: 6 }, (_, index) =>
      violation(`bad${index}`, `Sentence ${index}.`),
    )

    const content = buildRepairMessages(base, {
      type: 'vocabulary',
      reason: '出现表外词',
      violations,
    }).at(-1).content

    expect(content).toContain('请只修正不合法的地方')
    expect(content).not.toContain('把全文重写一遍')
  })
})
