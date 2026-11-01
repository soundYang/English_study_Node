import { countWords } from './word-count.js'

/**
 * 阅读 DTO。**白名单构造**，不写「删除敏感字段」的逻辑——
 * 「删除法」在新增字段时一定会漏，白名单法不会。
 */

/**
 * 自选词命中情况（md/54）。
 *
 * `missing` 从 `aiMeta.targetUsage.unused` 与 `targetPlan.selectedWords` 的交集算，
 * 不单独落库——存两份迟早分叉。`unused` 已经按词形变化统计（runs → run），
 * 所以这里只做小写比对，不再展开词形。
 */
function buildFocusWords(doc) {
  const requested = doc.targetPlan?.selectedWords ?? []
  const unused = new Set(
    (doc.aiMeta?.targetUsage?.unused ?? []).map((word) => String(word).toLowerCase()),
  )

  return {
    requested: [...requested],
    missing: requested.filter((word) => unused.has(String(word).toLowerCase())),
  }
}

/**
 * 安全 DTO：13 个字段，一个都不能少。
 *
 * 绝对不包含：translation、correctAnswer、explanation、userAnswers、
 * score、correctCount、names、aiMeta。
 *
 * `status` 必须有——前端拿它判断是否需要重定向到结果页，
 * 漏掉就会停在「答题中」却渲染不出内容。
 *
 * 新增四样都是给用户看的，不是内部数据：
 *   actualWords —— 文章页显示「全文 218 词」
 *   newWords    —— 折叠提示「本文含 4 个未学单词」
 *   focusWords  —— md/54：自选词的命中情况（requested / missing）
 *   tokenUsage  —— 显示「本次消耗 N tokens」
 */
export function toSafeDto(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    article: doc.article,
    level: doc.level,
    targetWords: doc.targetWords,
    // 老文档也一定有这个字段；兜底是为了防御手工写入的脏数据
    actualWords: doc.actualWords ?? countWords(doc.article),
    questionCount: doc.questionCount,
    status: doc.status,
    createdAt: doc.createdAt,
    newWords: (doc.newWords ?? []).map((item) => ({
      word: item.word,
      phonetic: { uk: item.phonetic?.uk ?? '', us: item.phonetic?.us ?? '' },
      senses: (item.senses ?? []).map(({ pos, meaning }) => ({ pos, meaning })),
      source: item.source,
    })),
    // md/54：用户自选词的命中情况。老文档没有 selectedWords / targetUsage，
    // 两个数组都回空——字段始终存在，前端不用判 undefined。
    focusWords: buildFocusWords(doc),
    // md/56 §6.3：本篇实际用到了用户的哪些词。P2 之前生成的文档没有这个字段，
    // 回空数组而不是 null，前端不用判空类型。
    //
    // 只回 `word / count / kind` 三个**落库时的事实**，不回 `status / reviewStage`：
    // 那是词库此刻的状态，跟这篇历史文章没关系，塞进来会让同一篇文章两次刷新
    // 显示不同的结果。前端要显示当前状态，拿 `word` 去词汇页那份列表里查即可。
    usedWords: (doc.usedWords ?? []).map(({ word, count, kind }) => ({ word, count, kind })),
    tokenUsage: {
      promptTokens: doc.aiMeta?.promptTokens ?? 0,
      completionTokens: doc.aiMeta?.completionTokens ?? 0,
      totalTokens: doc.aiMeta?.totalTokens ?? 0,
    },
    questions: (doc.questions || []).map((question) => ({
      id: question.id,
      question: question.question,
      // W7：题型给答题页做标签（细节题 / 推断题……），不泄露答案。
      // evidence **不在这里**：那正是答案所在的句子
      type: question.type ?? null,
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
 * @returns {Array<{ questionId: number, selectedOption: number | null, correctAnswer: number, isCorrect: boolean, explanation: string, evidence: string }>}
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
      // W7：原文依据，只在结果页给——答题前返回等于直接告诉用户答案在哪一句
      evidence: question.evidence ?? '',
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
    // 历史页要能显示「这一篇花了多少 token」，只给总数，拆分留在详情里
    tokenUsage: { totalTokens: doc.aiMeta?.totalTokens ?? 0 },
  }
}
