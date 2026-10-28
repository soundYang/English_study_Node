/**
 * 提示词拆成两段：
 *   系统提示词 —— 稳定，负责规则
 *   用户消息   —— 每次不同，负责参数
 */

import { REPEAT_PLAN } from './target-plan.js'

const SYSTEM_PROMPT = `你是英语阅读材料的编写者。你必须严格遵守以下规则：
1. 只能使用【目标词】【补充可用词】【基础词】三份清单里出现的单词，以及它们的合法词形变化（复数、第三人称单数、规则过去式、现在分词、比较级、最高级）。
2. 不得为了表达需要使用表外词汇。需要表达表外概念时，改写句子，而不是换词。
3. 文章必须语法正确、逻辑连贯。难度由两件事共同决定：句式复杂度（easy 用短句和常见句式；medium 允许句子连接与人物互动；hard 允许更长的从句和更复杂的信息组织）和用词层级（easy 以【基础词】为主，hard 可以更多使用【目标词】与【补充可用词】）。
4. 难度提升只能通过句式和情节复杂度实现，不能通过引入生词实现。
5. 【目标词】清单里的单词必须全部出现在正文中：带 ★ 的重点词各出现 2–3 次，其余目标词各出现 1–2 次。
6. 不要为了凑目标词写出不自然的句子。实在放不进去时，优先保证文章通顺可读。
7. 正文词数应贴近 targetWords，允许上下浮动 5% 左右。
8. 需要人名时最多使用 3 个，并在 names 字段里声明；除人名和星期、月份名称外，不得出现其他专有名词。
9. 题目必须能根据文章内容回答，每题只有一个正确答案，四个选项互不重复。
10. 中文翻译必须与英文正文逐段对应，不得增删内容。
11. 如果三份清单里的词太少、确实无法写出通顺文章，返回 {"error": "INSUFFICIENT_VOCABULARY"}，不要强行编造。
12. 只输出一个 JSON 对象，不要输出 Markdown 代码块标记或任何解释性文字。`

/** 按首字母分组能显著压缩 token，比一个长数组便宜 */
function groupByLetter(words) {
  const groups = new Map()

  for (const word of [...words].sort()) {
    const letter = word[0]
    if (!groups.has(letter)) groups.set(letter, [])

    groups.get(letter).push(word)
  }

  return [...groups.entries()]
    .map(([letter, list]) => `${letter}: ${list.join(' ')}`)
    .join('\n')
}

/**
 * 词表分三段渲染。
 *
 * 平铺一份 allowedWords 时，模型分不清「必须用的」和「能用的」，
 * 选池做得再准也传不到正文里（方案 §7.1）。
 */
function renderWordSections({ focusWords, targetWordList, supportWords, basicWords }) {
  const blocks = []
  const totalTargets = focusWords.length + targetWordList.length

  if (totalTargets > 0) {
    blocks.push(`【目标词】共 ${totalTargets} 个，必须全部出现在正文中。`)

    if (focusWords.length > 0) {
      blocks.push(
        `其中加 ★ 的 ${focusWords.length} 个重点词请各出现 `
          + `${REPEAT_PLAN.focus.min}–${REPEAT_PLAN.focus.max} 次：\n`
          + focusWords.map((word) => `★ ${word}`).join(' '),
      )
    }

    if (targetWordList.length > 0) {
      blocks.push(
        `其余 ${targetWordList.length} 个各出现 `
          + `${REPEAT_PLAN.target.min}–${REPEAT_PLAN.target.max} 次：\n`
          + groupByLetter(targetWordList),
      )
    }
  }

  if (supportWords.length > 0) {
    blocks.push(
      `【补充可用词】共 ${supportWords.length} 个，已学过，可以自由使用：\n`
        + groupByLetter(supportWords),
    )
  }

  if (basicWords.length > 0) {
    blocks.push(
      `【基础词】共 ${basicWords.length} 个，仅用于保证语法通顺，不承担复习作用：\n`
        + groupByLetter(basicWords),
    )
  }

  return blocks.join('\n\n')
}

/**
 * @param {{
 *   level: string,
 *   targetWords: number,
 *   questionCount: number,
 *   focusWords?: string[],      // 加 ★ 的重点词
 *   targetWordList?: string[],  // 普通目标词
 *   supportWords?: string[],    // 池内但不必出现的词
 *   basicWords?: string[],      // 个人基础词
 * }} params
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function buildMessages({
  level,
  targetWords,
  questionCount,
  focusWords = [],
  targetWordList = [],
  supportWords = [],
  basicWords = [],
}) {
  const sections = renderWordSections({
    focusWords: [...focusWords],
    targetWordList: [...targetWordList],
    supportWords: [...supportWords],
    basicWords: [...basicWords],
  })

  const userMessage = `level: ${level}
targetWords: ${targetWords}
questionCount: ${questionCount}

${sections}

请输出如下结构的 json：
{
  "title": "string",
  "article": "string",
  "translation": "string",
  "names": ["string"],
  "questions": [
    { "id": 1, "question": "string", "options": ["…","…","…","…"], "correctAnswer": 0, "explanation": "string" }
  ]
}`

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ]
}

/** 句子太长会把修正轮的 token 预算吃掉，截断即可定位问题 */
function truncate(text, max = 160) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 结构或词汇不合规时追加一条修正指令，让模型只改出问题的地方、不重写全文。
 *
 * @param {Array} messages 原始消息
 * @param {{ reason: string, violations?: Array<{ word: string, sentence: string }> }} feedback
 * @param {string} [previousContent] 上一轮模型自己的输出。结构合法时一定要带上，
 *   否则本轮说「你上一次的输出不符合约定」时，模型根本没看过上一次写了什么；
 *   结构不合法时不要带，避免把半截 JSON 喂回去。
 */
export function buildRepairMessages(
  messages,
  { reason, violations = [] },
  previousContent = '',
) {
  const details = violations.length
    ? `\n\n以下单词不在允许词表中，请改写包含它们的句子，只替换这几处表达：\n${violations
        .slice(0, 8)
        .map(({ word, sentence }) =>
          sentence ? `- "${word}"：${truncate(sentence)}` : `- "${word}"`,
        )
        .join('\n')}`
    : ''

  return [
    ...messages,
    ...(previousContent ? [{ role: 'assistant', content: previousContent }] : []),
    {
      role: 'user',
      content: `你上一次的输出不符合约定：${reason}。${details}\n\n请只修正不合法的地方，其余内容尽量保持不变，重新输出完整的 json 对象。`,
    },
  ]
}
