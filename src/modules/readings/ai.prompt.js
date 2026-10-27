/**
 * 提示词拆成两段：
 *   系统提示词 —— 稳定，负责规则
 *   用户消息   —— 每次不同，负责参数
 */

const SYSTEM_PROMPT = `你是英语阅读材料的编写者。你必须严格遵守以下规则：
1. 只能使用 allowedWords 中出现的单词，以及它们的合法词形变化（复数、第三人称单数、规则过去式、现在分词、比较级、最高级）。
2. 不得为了表达需要使用表外词汇。需要表达表外概念时，改写句子，而不是换词。
3. 文章必须语法正确、逻辑连贯，符合 level 指定的复杂度：easy 用短句和常见句式；medium 允许句子连接与人物互动；hard 允许更长的从句和更复杂的信息组织。
4. 难度提升只能通过句式和情节复杂度实现，不能通过引入生词实现。
5. 需要人名时最多使用 3 个，并在 names 字段里声明；除人名和星期、月份名称外，不得出现其他专有名词。
6. 题目必须能根据文章内容回答，每题只有一个正确答案，四个选项互不重复。
7. 中文翻译必须与英文正文逐段对应，不得增删内容。
8. 如果 allowedWords 太少、确实无法写出通顺文章，返回 {"error": "INSUFFICIENT_VOCABULARY"}，不要强行编造。
9. 只输出一个 JSON 对象，不要输出 Markdown 代码块标记或任何解释性文字。`

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
 * @param {{ level: string, targetWords: number, questionCount: number, allowedWords: Set<string> | string[] }} params
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function buildMessages({ level, targetWords, questionCount, allowedWords }) {
  const words = [...allowedWords]

  const userMessage = `level: ${level}
targetWords: ${targetWords}
questionCount: ${questionCount}
allowedWords（共 ${words.length} 个，按字母分组）:
${groupByLetter(words)}

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
 */
export function buildRepairMessages(messages, { reason, violations = [] }) {
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
    {
      role: 'user',
      content: `你上一次的输出不符合约定：${reason}。${details}\n\n请只修正不合法的地方，其余内容尽量保持不变，重新输出完整的 json 对象。`,
    },
  ]
}
