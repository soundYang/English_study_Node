import { z } from 'zod'

/**
 * 题目类型（md/21 W7）。
 *
 * 难度不能只体现在正文上：全是细节题的文章，hard 也只是「长一点的 easy」。
 * 这里给每道题一个可检查的类型标签，配额由 validateAiReading 按难度执行。
 */
export const QUESTION_TYPES = Object.freeze(['detail', 'paraphrase', 'inference', 'main_idea'])

/**
 * AI 输出的结构校验。
 * 只校验「形状」，词汇是否超纲由 S7 的 vocabulary.service 负责。
 */
export const aiReadingSchema = z.object({
  title: z.string().trim().min(1).max(120),
  article: z.string().trim().min(100).max(6000),
  translation: z.string().trim().min(20),
  names: z.array(z.string().trim().min(1).max(30)).max(3).default([]),
  questions: z
    .array(
      z.object({
        id: z.number().int().positive(),
        question: z.string().trim().min(5).max(300),
        options: z.array(z.string().trim().min(1).max(200)).length(4),
        correctAnswer: z.number().int().min(0).max(3),
        explanation: z.string().trim().min(1).max(500),
        // W7：题型与原文依据。两者都是确定性校验的输入，缺一个就没法查
        type: z.enum(QUESTION_TYPES),
        evidence: z.string().trim().min(1).max(300),
      }),
    )
    .min(1),
})

/** 统一正文与 evidence 的比较形态：大小写、全半角、引号、破折号、空白 */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 选项重合度里不参与计算的高频虚词：它们到处都有，算进来只会让伪造的选项也通过 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'at', 'and', 'or', 'but', 'not', 'no', 'it', 'its', 'this', 'that',
  'these', 'those', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'we',
  'you', 'i', 'me', 'my', 'our', 'your', 'with', 'for', 'by', 'from', 'as',
  'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
  'there', 'here', 'when', 'then', 'than', 'so', 'if', 'because',
])

function contentTokens(text) {
  return (String(text ?? '').match(/[A-Za-z]+(?:'[A-Za-z]+)*/g) ?? [])
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
}

const TYPE_QUOTA = Object.freeze({
  // easy 的题目必须能从原文直接找到答案，至少两道细节题
  easy: (question) => question.type === 'detail',
  // hard 必须有一道需要跨句推断或概括的题
  hard: (question) => question.type === 'inference' || question.type === 'main_idea',
})

const TYPE_QUOTA_MIN = Object.freeze({ easy: 2, hard: 1 })

const QUOTA_HINT = Object.freeze({
  easy: '至少 2 道 detail 题',
  hard: '至少 1 道 inference 或 main_idea 题',
})

/**
 * 题目质量的确定性校验（md/21 W7）：不调模型，纯字符串计算。
 *
 * 三条规则：
 *   1. evidence 必须是正文里真实存在的片段——编造的引文说明题目也不是从原文来的；
 *   2. 每档有题型配额：easy 至少 2 道 detail，hard 至少 1 道 inference / main_idea；
 *   3. detail 题的正确答案选项要与 evidence 有 ≥50% 的实词重合——
 *      选项与依据毫无关系时，只能靠背题，不能靠读文章。
 *
 * @returns {string|null} 不合法时返回原因，合法返回 null
 */
export function checkQuestionQuality(questions, article, level) {
  const normalizedArticle = normalize(article)

  for (const question of questions) {
    if (!normalizedArticle.includes(normalize(question.evidence))) {
      return `第 ${question.id} 题的 evidence 在正文里找不到：「${question.evidence}」`
    }
  }

  const quotaTest = TYPE_QUOTA[level]
  if (quotaTest) {
    const matched = questions.filter(quotaTest).length
    if (matched < TYPE_QUOTA_MIN[level]) {
      return `难度 ${level} 的题目需要${QUOTA_HINT[level]}，实际只有 ${matched} 道`
    }
  }

  for (const question of questions) {
    if (question.type !== 'detail') continue

    const answer = contentTokens(question.options[question.correctAnswer])
    if (!answer.length) continue

    const evidence = new Set(contentTokens(question.evidence))
    const hits = answer.filter((word) => evidence.has(word)).length

    if (hits / answer.length < 0.5) {
      return `第 ${question.id} 题是 detail 题，但正确答案与 evidence 几乎无关`
    }
  }

  return null
}

/**
 * 不校验题目的版本：给离线回放用（W7）。
 *
 * 库里 2026-10 之前的历史样本没有 `type` / `evidence`，题目规则在它们身上无从执行。
 * 回放要守的是「正文层面的结构仍然合法」，所以只去掉 questions 这一段，
 * 而不是给生产校验开一个可以随手关掉的口子。
 */
const articleLevelSchema = aiReadingSchema.omit({ questions: true })

/**
 * zod 之外的派生校验。
 *
 * `kind` 让调用方区分两类失败：`questions` 只需要重出题目，
 * `structure` 必须整篇重写——前者保留正文能省掉一次昂贵的重写。
 *
 * @param {object} raw 模型输出的 JSON
 * @param {{ questionCount: number, level?: string, checkQuestions?: boolean }} options
 *   `checkQuestions: false` 只校验正文层面（历史样本回放，见 articleLevelSchema）
 * @returns {{ ok: true, data: object } | { ok: false, kind?: 'questions', reason: string }}
 */
export function validateAiReading(raw, { questionCount, level, checkQuestions = true }) {
  if (!checkQuestions) {
    const articleOnly = articleLevelSchema.safeParse(raw)

    if (!articleOnly.success) {
      const issue = articleOnly.error.issues[0]
      return { ok: false, reason: `${issue.path.join('.') || '结构'}：${issue.message}` }
    }

    return { ok: true, data: articleOnly.data }
  }

  const parsed = aiReadingSchema.safeParse(raw)

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, reason: `${issue.path.join('.') || '结构'}：${issue.message}` }
  }

  const data = parsed.data

  if (data.questions.length !== questionCount) {
    return {
      ok: false,
      reason: `题目数量应为 ${questionCount}，实际 ${data.questions.length}`,
    }
  }

  const ids = data.questions.map((q) => q.id)
  const expected = ids.map((_, index) => index + 1)
  if (ids.some((id, index) => id !== expected[index])) {
    return { ok: false, reason: 'questions[].id 必须从 1 开始连续' }
  }

  for (const question of data.questions) {
    if (new Set(question.options).size !== 4) {
      return { ok: false, reason: `第 ${question.id} 题的四个选项必须互不重复` }
    }
  }

  const questionIssue = checkQuestionQuality(data.questions, data.article, level)
  if (questionIssue) return { ok: false, kind: 'questions', reason: questionIssue }

  return { ok: true, data }
}

/** 去掉模型偶尔加上的 ```json 代码块标记 */
export function stripCodeFence(text) {
  const trimmed = String(text ?? '').trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)

  return fenced ? fenced[1] : trimmed
}

/** 解析上游返回的文本；不是合法 JSON 时返回 null，交给调用方决定是否重试 */
export function parseAiContent(content) {
  try {
    return JSON.parse(stripCodeFence(content))
  } catch {
    return null
  }
}
