/**
 * 提示词拆成两段：
 *   系统提示词 —— 稳定，负责规则
 *   用户消息   —— 每次不同，负责参数
 */

import { REPEAT_PLAN } from './target-plan.js'
import { formatWordsPerSentence, planSentenceBudget, planWordRange } from './word-count.js'

/**
 * 第 7 条必须是**绝对数字**。
 * 原来写的是「允许上下浮动 5% 左右」，实测模型对相对值完全不敏感
 * （目标 200 词写出 429 词），换成区间后模型才有可执行的目标。
 * 但只给词数区间仍然写不稳（实测首轮 231 / 277 / 293），所以再给一份
 * **句子预算**：模型数不准词，却数得清自己写了几句。
 */
function systemPrompt(range) {
  const budget = planSentenceBudget(range)

  return `你是英语阅读材料的编写者。你必须严格遵守以下规则：
1. 只能使用【目标词】【补充可用词】【基础词】三份清单里出现的单词，以及它们的合法词形变化（复数、第三人称单数、规则过去式、现在分词、比较级、最高级）。
2. 不得为了表达需要使用表外词汇。需要表达表外概念时，改写句子，而不是换词。
3. 文章必须语法正确、逻辑连贯。难度由两件事共同决定：句式复杂度（easy 用短句和常见句式；medium 允许句子连接与人物互动；hard 允许更长的从句和更复杂的信息组织）和用词层级（easy 以【基础词】为主，hard 可以更多使用【目标词】与【补充可用词】）。
4. 难度提升只能通过句式和情节复杂度实现，不能通过引入生词实现。
5. 【目标词】清单里的单词必须全部出现在正文中：带 ★ 的重点词各出现 2–3 次，其余目标词各出现 1–2 次。
6. 不要为了凑目标词写出不自然的句子。实在放不进去时，优先保证文章通顺可读。
7. 正文必须控制在 ${range.min}–${range.max} 个英文单词之间（目标约 ${range.target} 词）：共 ${budget.minSentences}–${budget.maxSentences} 个句子，每句 ${formatWordsPerSentence(budget)} 个英文单词。不含题目、解析和中文翻译。少于 ${range.min} 词或多于 ${range.max} 词都不合格。
8. 需要人名时最多使用 3 个，并在 names 字段里声明；除人名和星期、月份名称外，不得出现其他专有名词。
9. 题目必须能根据文章内容回答，每题只有一个正确答案，四个选项互不重复。
10. 中文翻译必须与英文正文逐段对应，不得增删内容。
11. 如果三份清单里的词太少、确实无法写出通顺文章，返回 {"error": "INSUFFICIENT_VOCABULARY"}，不要强行编造。
12. 只输出一个 JSON 对象，不要输出 Markdown 代码块标记或任何解释性文字。`
}

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

  const range = planWordRange(targetWords)
  const budget = planSentenceBudget(range)

  const userMessage = `level: ${level}
targetWords: ${range.label}（目标约 ${range.target} 词；约 ${budget.sentences} 句，每句 ${formatWordsPerSentence(budget)} 词）
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
    { role: 'system', content: systemPrompt(range) },
    { role: 'user', content: userMessage },
  ]
}

/** 句子太长会把修正轮的 token 预算吃掉，截断即可定位问题 */
function truncate(text, max = 160) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 超过这个数量就不再逐句替换，改成全文重写（见 buildRepairMessages） */
const INLINE_VIOLATION_LIMIT = 8

/**
 * 违规词**全量列出**，原句只给前 8 条。
 *
 * 只列前 8 个时，19 个违规词模型只看到 8 个，一轮只能修 7 个左右
 * （实测 19→12→6、59→53→47）。词表本身很便宜，原句才是 token 大头。
 */
function renderViolations(violations) {
  if (!violations.length) return ''

  // 展示用 normalized（展开缩写、去所有格后的形式），模型看到的就是这个词本身；
  // token 带原句大小写，只在诊断里用
  const words = violations.map(({ normalized }) => normalized).join(', ')
  const snippets = violations
    .slice(0, INLINE_VIOLATION_LIMIT)
    .filter(({ sentence }) => sentence)
    .map(({ normalized, sentence }) => `- "${normalized}"：${truncate(sentence)}`)

  return `\n\n不在允许词表中的单词（共 ${violations.length} 个）：\n${words}`
    + (snippets.length ? `\n\n其中带原句的几条：\n${snippets.join('\n')}` : '')
}

/**
 * 生成修正指令。三种反馈共用一个入口：
 *   structure   —— 结构/JSON 不合法
 *   vocabulary  —— 表外词超过放行额度
 *   word_count  —— 正文超过篇幅上限，**不带上一篇、按句子预算重写**
 *
 * @param {Array} messages 原始消息
 * @param {{
 *   type?: 'structure' | 'vocabulary' | 'word_count',
 *   reason: string,
 *   violations?: Array<{ token: string, normalized: string, category: string, sentence: string }>,
 *   range?: { min: number, max: number, target: number },
 * }} feedback
 * @param {string} [previousContent] 上一轮模型自己的输出。结构合法时带上，
 *   否则本轮说「你上一次的输出不符合约定」时，模型根本没看过上一次写了什么；
 *   结构不合法时不带，避免把半截 JSON 喂回去；
 *   `word_count` 时也不带——锚定会让模型只做减法，删不干净。
 */
export function buildRepairMessages(
  messages,
  { type, reason, violations = [], range },
  previousContent = '',
) {
  // 篇幅修正：**不带上一篇正文**，改成按句子预算重新写一版。
  //
  // 带锚定时模型只会做减法：让它「删到 200–230」「至少删 35 个词」，
  // 实测都只删掉 14–20 个，最终停在 263–265。模型数不准词，但数得清句子，
  // 所以给它「几句 × 每句几词」的配料表，重新组织比事后删减可控。
  // 顺带的好处：不带 prior content 的修一轮比压缩便宜约 28%。
  const sentenceBudget = range ? planSentenceBudget(range) : null
  let instruction

  if (type === 'word_count') {
    instruction = `你上一次的正文长度不符合约定：${reason}。\n\n`
      + '请不要在上一篇上删改，直接用同一批目标词重新写一篇文章'
      + (sentenceBudget ? '：\n' : '。\n')
      + (sentenceBudget
        ? `- 共 ${sentenceBudget.minSentences}–${sentenceBudget.maxSentences} 个英文句子\n`
          + `- 每句 ${formatWordsPerSentence(sentenceBudget)} 个英文单词\n`
          + `- 全文目标约 ${range.target} 词，必须落在 ${range.min}–${range.max} 词之间\n`
        : '')
      + '【目标词】必须全部出现，情节可以重新安排。'
      // 无锚定重写等于重编故事，实测会带出 14 个表外词；开头就把用词边界钉死
      + '情节只能围绕【目标词】【补充可用词】【基础词】三份清单里的词安排，不要引入表外词。'
      + '标题、中文翻译和题目要与新正文对应，重新输出完整的 json 对象。'
  } else if (type === 'vocabulary' && violations.length > INLINE_VIOLATION_LIMIT) {
    // 十几处以上时逐句替换没有意义：模型按下葫芦浮起瓢（实测 59→53→47）。
    // 改成全文重写，但把违规词全量列出来，告诉它哪些必须消失。
    instruction = `你上一次的输出有 ${violations.length} 个不在允许词表中的单词，逐句替换会不断引入新的表外词。\n\n`
      + '请用三份清单里的词把全文重写一遍：\n'
      + '- 只能使用【目标词】【补充可用词】【基础词】里的词，不要引入任何表外词\n'
      + '- 【目标词】必须全部出现，情节可以重新安排\n'
      + (range ? `- 正文仍要控制在 ${range.min}–${range.max} 个英文单词之间\n` : '')
      + renderViolations(violations)
      + '\n\n重新输出完整的 json 对象。'
  } else {
    instruction = `你上一次的输出不符合约定：${reason}。${renderViolations(violations)}\n\n`
      + '请只修正不合法的地方，其余内容尽量保持不变'
      // 替换违规词时模型倾向加从句，不重申区间就会越修越长
      + (range ? `，修改后的正文仍需控制在 ${range.min}–${range.max} 个英文单词之间` : '')
      + '，重新输出完整的 json 对象。'
  }

  // 篇幅修正是「重写」不是「改写」，把上一篇塞回去只会让模型继续挤牙膏
  const includePrevious = previousContent && type !== 'word_count'

  return [
    ...messages,
    ...(includePrevious ? [{ role: 'assistant', content: previousContent }] : []),
    { role: 'user', content: instruction },
  ]
}
