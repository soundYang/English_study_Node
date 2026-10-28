/**
 * 提示词拆成两段：
 *   系统提示词 —— 稳定，负责规则
 *   用户消息   —— 每次不同，负责参数
 */

import { REPEAT_PLAN } from './target-plan.js'
import {
  formatWordsPerSentence,
  planExpandBudget,
  planSentenceBudget,
  planWordRange,
  segmentWordCeiling,
  wordsPerSentenceFor,
} from './word-count.js'

/**
 * 题型配额的提示词口径（W7）。
 *
 * 数字与 `ai.schema.js` 的 `TYPE_QUOTA` 一一对应：提示词说错，模型就照着写错，
 * 再由校验拦下来——等于拿一次模型调用换一个模型本来就能避免的问题。
 * 两边同时改是这份文件唯一需要人工同步的地方，注释留在这里提醒。
 */
function questionTypeRule(level) {
  if (level === 'easy') return '本难度至少 2 道 detail 题。'
  if (level === 'hard') return '本难度至少 1 道 inference 或 main_idea 题。'
  return '本难度不限制题型分布。'
}

/**
 * 第 7 条必须是**绝对数字**。
 * 原来写的是「允许上下浮动 5% 左右」，实测模型对相对值完全不敏感
 * （目标 200 词写出 429 词），换成区间后模型才有可执行的目标。
 * 但只给词数区间仍然写不稳（实测首轮 231 / 277 / 293），所以再给一份
 * **句子预算**：模型数不准词，却数得清自己写了几句。
 * W7 起每句基准词数由难度决定（easy 12 / medium 15 / hard 19）。
 */
function systemPrompt(range, level, freeForm = false) {
  const budget = planSentenceBudget(range, level)
  // 最终模式（md/30 §7.3）：没有目标词，清单少一份，第 5、6 条换成自由写作口径。
  // 不换的话模型会去找一份不存在的【目标词】，抽风式重复某个词来「凑」。
  const wordRule = freeForm
    ? '1. 只能使用【补充可用词】【基础词】两份清单里出现的单词，以及它们的合法词形变化（复数、第三人称单数、规则过去式、现在分词、比较级、最高级）。'
    : '1. 只能使用【目标词】【补充可用词】【基础词】三份清单里出现的单词，以及它们的合法词形变化（复数、第三人称单数、规则过去式、现在分词、比较级、最高级）。'
  const targetRule = freeForm
    ? '5. 本次没有指定的目标词：正文不要求出现任何特定单词，从清单里自由选词即可。\n6. 优先保证文章通顺可读，不要为了用某个词写出不自然的句子。'
    : '5. 【目标词】清单里的单词必须全部出现在正文中：带 ★ 的重点词各出现 2–3 次，其余目标词各出现 1–2 次。\n6. 不要为了凑目标词写出不自然的句子。实在放不进去时，优先保证文章通顺可读。'

  return `你是英语阅读材料的编写者。你必须严格遵守以下规则：
${wordRule}
2. 不得为了表达需要使用表外词汇。需要表达表外概念时，改写句子，而不是换词。
3. 文章必须语法正确、逻辑连贯。难度由两件事共同决定：句式复杂度（easy 用短句和常见句式；medium 允许句子连接与人物互动；hard 允许更长的从句和更复杂的信息组织）和用词层级（easy 以【基础词】为主，hard 可以更多使用${freeForm ? '【补充可用词】' : '【目标词】与【补充可用词】'}）。
4. 难度提升只能通过句式和情节复杂度实现，不能通过引入生词实现。
${targetRule}
7. 正文必须控制在 ${range.min}–${range.max} 个英文单词之间（目标约 ${range.target} 词）：共 ${budget.minSentences}–${budget.maxSentences} 个句子，每句 ${formatWordsPerSentence(budget)} 个英文单词。不含题目、解析和中文翻译。少于 ${range.min} 词或多于 ${range.max} 词都不合格。
8. 需要人名时最多使用 3 个，并在 names 字段里声明；除人名和星期、月份名称外，不得出现其他专有名词。
9. 题目必须能根据文章内容回答，每题只有一个正确答案，四个选项互不重复。
10. 每道题必须给出两个字段：
    - type：detail（原文能直接找到答案）/ paraphrase（换一种说法）/ inference（需要跨句推断）/ main_idea（概括主旨）；
    - evidence：从正文**原样复制**一句作为依据，不要改写、不要加引号之外的内容。
    ${questionTypeRule(level)}
    detail 题的正确答案必须能在 evidence 里找到对应词，不能只靠常识判断。
11. 中文翻译必须与英文正文逐段对应，不得增删内容。
12. 如果三份清单里的词太少、确实无法写出通顺文章，返回 {"error": "INSUFFICIENT_VOCABULARY"}，不要强行编造。
13. 只输出一个 JSON 对象，不要输出 Markdown 代码块标记或任何解释性文字。`
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
 *   freeForm?: boolean,         // 最终模式：不设目标词（md/30 §7.3）
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
  freeForm = false,
}) {
  const sections = renderWordSections({
    focusWords: [...focusWords],
    targetWordList: [...targetWordList],
    supportWords: [...supportWords],
    basicWords: [...basicWords],
  })

  const range = planWordRange(targetWords)
  // W7：每句基准词数由难度决定，sentence 预算与 system 提示词必须读同一个预算
  const budget = planSentenceBudget(range, level)

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
    { "id": 1, "question": "string", "type": "detail", "evidence": "正文里原样的一句", "options": ["…","…","…","…"], "correctAnswer": 0, "explanation": "string" }
  ]
}`

  return [
    { role: 'system', content: systemPrompt(range, level, freeForm) },
    { role: 'user', content: userMessage },
  ]
}

// ——————————————————————————————————————————————————————————————
// 分段路径（md/21 W4 / md/20 §5）
//
// 规划、分段、收尾三次任务共用一个 system 消息，且**必须逐字节一致**：
// DeepSeek 的前缀缓存按前缀命中，system 里一掺进「第几段」这种变量，
// 后面每一次调用都会重新计费输入 token（成本翻 2–3 倍）。
// ——————————————————————————————————————————————————————————————

/**
 * 分段路径的 system 消息：规则 + 三份词表，与具体段落无关。
 * 调用方建一次，规划 / 每段 / 收尾全部原样复用。
 */
export function buildSegmentedSystem({
  level,
  targetWords,
  basicWords = [],
  focusWords = [],
  targetWordList = [],
  supportWords = [],
  freeForm = false,
}) {
  const sections = renderWordSections({
    focusWords: [...focusWords],
    targetWordList: [...targetWordList],
    supportWords: [...supportWords],
    basicWords: [...basicWords],
  })

  // 最终模式（md/30 §7.3）：没有目标词清单，第 1、5、6 条换成自由写作口径。
  // 这条分支必须和 renderWordSections 的空列表分支同时生效，
  // 否则模型会被要求「用不存在的【目标词】」而开始复读某个词。
  const wordRule = freeForm
    ? '1. 只能使用下面两份清单里的单词，以及它们的合法词形变化（复数、第三人称单数、规则过去式、现在分词、比较级、最高级）。'
    : '1. 只能使用下面三份清单里的单词，以及它们的合法词形变化（复数、第三人称单数、规则过去式、现在分词、比较级、最高级）。'
  const targetRule = freeForm
    ? '5. 本次没有指定的目标词：全文不要求出现任何特定单词，从清单里自由选词即可。\n6. 优先保证文章通顺可读，不要为了用某个词写出不自然的句子。'
    : '5. 【目标词】清单里的单词必须全部出现在全文里：带 ★ 的重点词各出现 2–3 次，其余目标词各出现 1–2 次。\n6. 不要为了凑目标词写出不自然的句子。实在放不进去时，优先保证文章通顺可读。'

  return `你是英语阅读材料的编写者。整篇文章分三步完成：先规划段落，再逐段写作，最后补标题、翻译与题目。你会分多次收到任务，每次只完成当前步骤，并且只输出一个 json 对象。

写作规则：
${wordRule}
2. 不得为了表达需要使用表外词汇。需要表达表外概念时，改写句子，而不是换词。
3. 每一段必须语法正确，并与前后段连贯：人物、时间、地点不能互相矛盾。
4. 难度（${level}）只能通过句式和情节复杂度提升，不能通过引入生词实现。
${targetRule}
7. 分段写作时，每段控制在本段要求的词数附近，每句约 ${wordsPerSentenceFor(level)} 个英文单词（本难度的句长基准）；各段合起来要接近全篇目标（约 ${targetWords} 词）。
8. 需要人名时最多使用 3 个，并在 names 字段里声明；除人名和星期、月份名称外，不得出现其他专有名词。
9. 题目必须能根据文章内容回答，每题只有一个正确答案，四个选项互不重复。
10. 每道题必须给出 type（detail / paraphrase / inference / main_idea）与 evidence（从正文原样复制的一句）。${questionTypeRule(level)}detail 题的正确答案必须能在 evidence 里找到对应词。
11. 中文翻译必须与英文正文逐段对应，不得增删内容。
12. 只输出当前步骤要求的 json 对象，不要输出 Markdown 代码块标记或任何解释性文字。

${sections}`
}

/**
 * ① 规划：一次调用产出段落计划。
 * 模型给不全时由代码补齐（plan.service.js），**不重试调用**。
 */
export function buildPlanMessages(system, { segmentCount, range }) {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `请把一篇约 ${range.target} 词（必须落在 ${range.min}–${range.max} 词）的英语短文拆成 ${segmentCount} 段。

每段给出：
- goal：这一段写什么，用中文一句话
- mustUse：这一段必须用到的目标词，只能从【目标词】里选
- maxWords：这一段大约多少个英文单词

要求：所有段落的 mustUse 合起来必须覆盖【目标词】里的每一个词，同一个词只能出现一次；各段 maxWords 之和要接近 ${range.target}。

只输出：
{"segments":[{"id":1,"goal":"…","mustUse":["…"],"maxWords":50}]}`,
    },
  ]
}

/** ② 分段写作：只带本段目标与相邻段的方向，不带全篇正文 */
export function buildSegmentMessages(
  system,
  { segment, index, total, outline = '', previousGoal = '', nextGoal = '' },
) {
  const mustUse = segment.mustUse.length
    ? `本段必须出现的目标词（共 ${segment.mustUse.length} 个）：${segment.mustUse.join(', ')}`
    : '本段没有指定必须出现的目标词。'
  const context = [
    previousGoal ? `上一段的方向：${previousGoal}` : '',
    nextGoal ? `下一段的方向：${nextGoal}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `全文计划：
${outline}

第 ${index}/${total} 段。
本段目标：${segment.goal}
${mustUse}
本段篇幅：约 ${segment.maxWords} 个英文单词，不要超过 ${segmentWordCeiling(segment.maxWords)} 个。
${context ? `${context}\n` : ''}
只写这一段的英文正文，不要标题、翻译、题目。输出：
{"text":"这一段英文"}`,
    },
  ]
}

/**
 * ③ 段内重写：只重写这一段，且**允许删掉这个意思**。
 * 这是整篇重写收敛不了的根本原因——旧提示词只允许换词，
 * 模型找不到词表内的替代说法时只能再编一个表外词。
 */
export function buildSegmentRepairMessages(
  system,
  { segment, index, text, violations, overWords = null },
) {
  const words = violations.map(({ normalized }) => normalized).join(', ')
  const snippets = violations
    .slice(0, INLINE_VIOLATION_LIMIT)
    .filter(({ sentence }) => sentence)
    .map(({ normalized, sentence }) => `- "${normalized}"：${truncate(sentence)}`)
    .join('\n')

  // 段级篇幅终检（md/30 §6-2）：只有超长时，没有生词可列，给一条压缩指令
  if (violations.length === 0 && overWords) {
    return [
      { role: 'system', content: system },
      ...(text ? [{ role: 'assistant', content: text }] : []),
      {
        role: 'user',
        content: `你刚写的第 ${index} 段有 ${overWords.actual} 个英文单词，超过本段上限 ${overWords.limit} 个词。
请压缩这一段：删掉次要的细节和重复的表达，保留主线，不要新编内容，也不要引入任何表外词。
本段上限 ${overWords.limit} 个英文单词。输出：
{"text":"压缩后的整段"}`,
      },
    ]
  }

  // 解析失败（返回不是 JSON / 没有 text）时没有可展示的原文，
  // 直接要它重写这一段，不要说「有 0 个生词」这种模型看不懂的话
  const instruction = violations.length === 0
    ? `你上一次没有返回可用的英文正文。请重新写第 ${index} 段：
本段目标：${segment.goal}
只能使用词表里的词，不要引入任何表外词。约 ${segment.maxWords} 个英文单词，不要超过 ${segmentWordCeiling(segment.maxWords)} 个。输出：
{"text":"这一段英文"}`
    : `你刚写的第 ${index} 段里有 ${violations.length} 个不在词表内的单词：${words}
${snippets ? `\n其中带原句的几条：\n${snippets}\n` : ''}
请只重写包含这些词的句子：可以换说法，也可以删掉这个意思，但不能引入任何表外词。其他句子保持不变。
${overWords ? `另外这一段现在有 ${overWords.actual} 个英文单词，超过本段上限 ${overWords.limit} 个，重写时请一并压到 ${overWords.limit} 个以内。\n` : ''}本段仍需约 ${segment.maxWords} 个英文单词。输出：
{"text":"重写后的整段"}`

  return [
    { role: 'system', content: system },
    ...(text ? [{ role: 'assistant', content: text }] : []),
    { role: 'user', content: instruction },
  ]
}

/**
 * ④ 降级：去掉没成功用上的目标词，用最简单的说法再写一次。
 * 走到这里说明「既要目标词、又要零表外词」已经无解，先保住文章。
 */
export function buildSegmentSimplifyMessages(system, { segment, index }) {
  const mustUse = segment.mustUse.length
    ? `这一段还尽量用上这些词（用不上可以不用）：${segment.mustUse.join(', ')}`
    : '这一段不必刻意用目标词。'

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `请用最简单的说法写第 ${index} 段。
本段目标：${segment.goal}
${mustUse}
只能使用【目标词】【补充可用词】【基础词】里的词，不要引入任何表外词。
约 ${segment.maxWords} 个英文单词，不要超过 ${segmentWordCeiling(segment.maxWords)} 个。只输出：
{"text":"这一段英文"}`,
    },
  ]
}

/** ⑤ 收尾：正文已定，只补标题、翻译、题目 */
export function buildFinishMessages(system, { article, questionCount, paragraphCount, level }) {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `下面是已经完成的英文正文（共 ${paragraphCount} 段）：
"""
${article}
"""

请只输出标题、中文翻译、题目与 names：
{"title":"…","translation":"…","names":["…"],"questions":[{"id":1,"question":"…","type":"detail","evidence":"正文里原样的一句","options":["…","…","…","…"],"correctAnswer":0,"explanation":"…"}]}

要求：翻译与正文逐段对应；题目共 ${questionCount} 道，id 从 1 开始连续，四个选项互不重复，答案必须能在正文中找到依据。
每道题的 evidence 必须从上面正文里原样复制一句；${questionTypeRule(level)}`,
    },
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
 * 生成修正指令。四种反馈共用一个入口：
 *   structure   —— 结构/JSON 不合法
 *   vocabulary  —— 表外词超过放行额度
 *   word_count  —— 正文超过篇幅上限，**不带上一篇、按句子预算重写**
 *   questions   —— 正文没问题，只有题目不合格（evidence 编造 / 题型配额 / detail 选项与依据无关），
 *                  **只重写题目**，正文原样保留
 *
 * @param {Array} messages 原始消息
 * @param {{
 *   type?: 'structure' | 'vocabulary' | 'word_count' | 'questions',
 *   reason: string,
 *   violations?: Array<{ token: string, normalized: string, category: string, sentence: string }>,
 *   range?: { min: number, max: number, target: number },
 * }} feedback
 * @param {string} [previousContent] 上一轮模型自己的输出。结构合法时带上，
 *   否则本轮说「你上一次的输出不符合约定」时，模型根本没看过上一次写了什么；
 *   结构不合法时不带，避免把半截 JSON 喂回去；
 *   `word_count` 时也不带——锚定会让模型只做减法，删不干净。
 * @param {string} [level] 难度：题型配额与句中词数都跟它走
 */
export function buildRepairMessages(
  messages,
  { type, reason, violations = [], range },
  previousContent = '',
  level,
) {
  // 篇幅修正：**不带上一篇正文**，改成按句子预算重新写一版。
  //
  // 带锚定时模型只会做减法：让它「删到 200–230」「至少删 35 个词」，
  // 实测都只删掉 14–20 个，最终停在 263–265。模型数不准词，但数得清句子，
  // 所以给它「几句 × 每句几词」的配料表，重新组织比事后删减可控。
  // 顺带的好处：不带 prior content 的修一轮比压缩便宜约 28%。
  const sentenceBudget = range ? planSentenceBudget(range, level) : null
  let instruction

  if (type === 'questions') {
    // 只重写题目：正文已经通过词表与篇幅校验，重写整篇等于把两次调用的成果丢掉，
    // 还会带出新的表外词。evidence 编造这类问题模型完全有能力只改题目就修好。
    instruction = `你上一次的题目不符合要求：${reason}。\n\n`
      + '请保持 title、article、translation 与 names 完全不变，只重写 questions：\n'
      + '- 每道题都要有 type 与 evidence；evidence 必须从正文里**原样复制**一句，不要改写\n'
      + `- ${questionTypeRule(level)}\n`
      + '- detail 题的正确答案必须能在 evidence 里找到对应词\n'
      + '- 题目数量、id 从 1 开始连续、四个选项互不重复这几条照旧\n'
      + '重新输出完整的 json 对象。'
  } else if (type === 'word_count') {
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

/**
 * 扩写指令（W6）：正文偏短时在原稿上补几句，而不是重写。
 *
 * 与 `word_count`（超长）刚好相反：那里必须**不带**上一篇，因为带锚点模型只会做减法；
 * 这里必须**带上**上一篇，因为扩写的语义就是"在这篇文章上补"，
 * 重写一遍反而更容易换情节、带出表外词。
 *
 * @param {Array} messages 原始消息
 * @param {{
 *   actualWords: number,
 *   range: { min: number, target: number, max: number },
 *   acceptedRange: { min: number, max: number, label: string },
 * }} feedback
 * @param {string} previousContent 上一轮（结构合法的）完整输出
 * @param {string} [level] 难度：easy 的句子更短，补几句要按该档的句长折算
 */
export function buildExpandMessages(
  messages,
  { actualWords, range, acceptedRange },
  previousContent,
  level,
) {
  const { shortfall, sentences } = planExpandBudget(actualWords, range, level)
  const shortfallText = shortfall > 0 ? `，约 ${shortfall} 词` : ''

  const instruction = `你上一次的正文偏短：只有 ${actualWords} 个英文单词，验收下限是 ${acceptedRange.min}。\n\n`
    + `请保留原来的情节和已有的每一句，只在合适的位置补写 ${sentences} 个英文句子${shortfallText}：\n`
    + '- 补细节：人物的动作、看到或听到的东西、当时的环境\n'
    + '- 补因果：这件事为什么发生、后来怎么样了\n'
    + '- 补感受：人物当时在想什么\n\n'
    + '要求：\n'
    + '- 不要删掉已有的句子，也不要靠重复同一句话凑字数\n'
    + '- 补写的部分只能使用【目标词】【补充可用词】【基础词】里的词\n'
    + `- 改完后全文要落在 ${range.min}–${range.max} 个英文单词之间（目标约 ${range.target} 词）\n`
    + '- 标题保持不变，中文翻译和题目跟着正文更新，重新输出完整的 json 对象'

  return [
    ...messages,
    ...(previousContent ? [{ role: 'assistant', content: previousContent }] : []),
    { role: 'user', content: instruction },
  ]
}
