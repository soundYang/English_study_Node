import { z } from 'zod'

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
      }),
    )
    .min(1),
})

/**
 * zod 之外的派生校验。
 *
 * @returns {{ ok: true, data: object } | { ok: false, reason: string }}
 */
export function validateAiReading(raw, { questionCount }) {
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
