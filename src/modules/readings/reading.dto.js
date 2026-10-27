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

/** Mongoose 的 Map 键一律是字符串，用数字下标取会静默取不到 */
function toAnswersMap(userAnswers) {
  if (!userAnswers) return {}

  return userAnswers instanceof Map
    ? Object.fromEntries(userAnswers)
    : { ...userAnswers }
}

/**
 * 逐题判分。**只看库里的 correctAnswer，永不信客户端**。
 * 未作答（提交里没有这一题，或 selectedOption 为 null）判错但不报错。
 *
 * @returns {Array<{ questionId: number, selectedOption: number | null, correctAnswer: number, isCorrect: boolean, explanation: string }>}
 */
export function buildResults(doc) {
  const answers = toAnswersMap(doc.userAnswers)

  return (doc.questions || []).map((question) => {
    const raw = answers[String(question.id)]
    const selectedOption = raw === undefined || raw === null ? null : Number(raw)

    return {
      questionId: question.id,
      selectedOption,
      correctAnswer: question.correctAnswer,
      isCorrect: selectedOption === question.correctAnswer,
      explanation: question.explanation,
    }
  })
}

/**
 * 已提交后的完整结果 DTO（提交响应与 GET /:id 的 submitted 分支共用）。
 *
 * 在安全 DTO 之上追加翻译、成绩与逐题解析——
 * 结果页的「题目解析」整块依赖 results + questions，两者缺一不可。
 * 仍然不返回 vocabularySnapshot / names / aiMeta。
 */
export function toResultDto(doc) {
  const results = buildResults(doc)

  return {
    ...toSafeDto(doc),
    submittedAt: doc.submittedAt,
    score: doc.score,
    correctCount: doc.correctCount,
    totalQuestions: (doc.questions || []).length,
    accuracy: doc.score,
    translation: doc.translation,
    results,
  }
}

/**
 * 历史列表条目。未提交的记录 score / accuracy / submittedAt 都是 null，
 * 前端据此区分"继续作答"和"查看结果"。
 */
export function toHistoryItem(doc) {
  const submitted = doc.status === 'submitted'

  return {
    id: String(doc._id),
    title: doc.title,
    level: doc.level,
    questionCount: doc.questionCount,
    status: doc.status,
    score: submitted ? doc.score : null,
    // 前端两个字段都读，必须同值
    accuracy: submitted ? doc.score : null,
    createdAt: doc.createdAt,
    submittedAt: submitted ? doc.submittedAt : null,
  }
}
