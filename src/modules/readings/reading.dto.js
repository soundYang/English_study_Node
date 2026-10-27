/**
 * 阅读 DTO。**白名单构造**，不写「删除敏感字段」的逻辑——
 * 「删除法」在新增字段时一定会漏，白名单法不会。
 */

/**
 * 安全 DTO：9 个字段，一个都不能少。
 *
 * 绝对不包含：translation、correctAnswer、explanation、userAnswers、
 * score、correctCount、names、aiMeta。
 *
 * `status` 必须有——前端拿它判断是否需要重定向到结果页，
 * 漏掉就会停在「答题中」却渲染不出内容。
 */
export function toSafeDto(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    article: doc.article,
    level: doc.level,
    targetWords: doc.targetWords,
    questionCount: doc.questionCount,
    status: doc.status,
    createdAt: doc.createdAt,
    questions: (doc.questions || []).map((question) => ({
      id: question.id,
      question: question.question,
      options: [...question.options],
    })),
  }
}
