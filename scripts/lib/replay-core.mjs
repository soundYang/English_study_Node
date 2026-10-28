/**
 * 离线回放的核心逻辑（纯函数，不碰数据库、不调模型）。
 *
 * 为什么单独抽出来：
 *   回归脚本（scripts/replay-suite.mjs）和单元测试（src/tests/replay-fixtures.test.js）
 *   必须用同一套判定，否则「脚本说没问题、测试说坏了」时又得停下来查工具本身。
 *
 * 这里只回答一个问题：给定一篇已经生成好的正文和一份允许词表，
 * 当前版本的校验器会把它判成什么样。它不重放修复轮——修复轮依赖模型输出，
 * 而历史样本只留下了最终正文。
 */

import { ABBREVIATION_WORDS } from '../../src/modules/readings/abbreviations.js'
import { validateAiReading } from '../../src/modules/readings/ai.schema.js'
import { calendarWords } from '../../src/modules/readings/calendar-words.js'
import { validateArticle } from '../../src/modules/readings/vocabulary.service.js'
import { countWords } from '../../src/modules/readings/word-count.js'

/**
 * 允许词 = 用户已学/已掌握 ∪ 基础词 ∪ 日历词 ∪ 缩写词。
 *
 * 与 reading.service.js 的组装规则保持一致；`new` 状态**不算**——
 * 生成时 findVocabulary 就把它排除了，回放不能比真实链路更宽松。
 */
export function buildAllowedWords(userRecord, basicList) {
  const learning = userRecord?.learning ?? []
  const mastered = userRecord?.mastered ?? []

  return new Set([
    ...learning,
    ...mastered,
    ...basicList,
    ...calendarWords,
    ...ABBREVIATION_WORDS,
  ])
}

/**
 * 从 GenerationFailure.finalArticle 里还原正文。
 *
 * 三种形态都真实存在过：
 *   · 合法 JSON → 取 article
 *   · 模型没按 JSON 输出 → 整段就是正文
 *   · 结构失败且内容为空 → 没有可回放的东西
 */
export function extractArticle(raw) {
  const text = String(raw ?? '').trim()

  if (!text) return { kind: 'empty', article: '', names: [] }

  if (text.startsWith('{')) {
    try {
      const payload = JSON.parse(text)
      if (typeof payload?.article === 'string' && payload.article.trim()) {
        return { kind: 'json', article: payload.article, names: payload.names ?? [] }
      }
    } catch {
      // 被截断的 JSON：下面的裸文本分支会把它当作正文片段处理
    }
  }

  // 至少几个词才算正文，否则大概率是半截 JSON 或错误信息
  return /[A-Za-z]+(?:\s+[A-Za-z]+){5,}/.test(text)
    ? { kind: 'text', article: text, names: [] }
    : { kind: 'empty', article: '', names: [] }
}

/**
 * 回放一个样本。
 *
 * @returns {{
 *   id: string, source: 'reading'|'failure', userId: string,
 *   level: string, targetWords: number, kind: string,
 *   actualWords: number, unknownCount: number, violationCount: number,
 *   counts: Record<string, number>,
 *   withinBudget: boolean,
 *   structure: 'ok'|'invalid'|'skip',
 *   storedOutcome: 'accepted'|'failed',
 *   agreesWithStored: boolean,
 * }}
 */
/**
 * 按难度取生词预算。
 *
 * W3 之后预算不再是一个全局数字（easy 0 / medium 3 / hard 5）。回放要么传
 * `{ easy, medium, hard }`，要么传一个数字把所有难度压成同一口径（用于 A/B 对比）。
 * 这与 `basicList` 的处理方式一致：分档是默认，扁平是显式覆盖。
 */
export function budgetFor(budget, level) {
  if (typeof budget === 'number') return budget

  return budget?.[level] ?? budget?.easy ?? 0
}

export function replayCase(testCase, userRecord, basicList, budget) {
  const { kind, article, names } = testCase.kind === 'plain'
    ? { kind: 'plain', article: testCase.article, names: testCase.names ?? [] }
    : extractArticle(testCase.article)

  const allowedWords = buildAllowedWords(userRecord, basicList)
  const vocabulary = kind === 'empty'
    ? null
    : validateArticle({ article, allowedWords, names })

  // checkQuestions: false —— 历史样本（2026-10 之前）没有 type / evidence，
  // W7 的题目规则在它们身上无从执行。回放守的是正文层面的结构不变量，
  // 题目质量由 ai-schema.test.js 与集成测试覆盖。
  const structure = kind === 'empty' || testCase.source !== 'reading'
    ? 'skip'
    : (validateAiReading(
        {
          title: testCase.title,
          article,
          translation: testCase.translation,
          names,
          questions: testCase.questions ?? [],
        },
        { questionCount: testCase.questionCount, checkQuestions: false },
      ).ok ? 'ok' : 'invalid')

  const unknownCount = vocabulary?.unknownWords.length ?? 0
  const withinBudget = unknownCount <= budgetFor(budget, testCase.level)
  const storedOutcome = testCase.source === 'reading' ? 'accepted' : 'failed'
  // 失败样本记的是 finalUnknownWords，成功样本记的是 aiMeta.violationsCount
  const storedViolationsCount = testCase.source === 'reading'
    ? (testCase.stored?.violationsCount ?? null)
    : (testCase.stored?.unknownWords?.length ?? null)

  return {
    id: testCase.id,
    source: testCase.source,
    userId: testCase.userId,
    level: testCase.level,
    targetWords: testCase.targetWords,
    kind,
    actualWords: kind === 'empty' ? 0 : countWords(article),
    unknownCount,
    violationCount: vocabulary?.violations.length ?? 0,
    counts: vocabulary?.counts ?? null,
    withinBudget,
    structure,
    storedOutcome,
    storedViolationsCount,
    // 诊断用，不是断言：历史上确实存在「放行了但超预算」的样本（§6.8）
    agreesWithStored:
      (storedOutcome === 'accepted' && withinBudget)
      || (storedOutcome === 'failed' && !withinBudget),
  }
}

/**
 * 按难度取词表。
 *
 * 分档之后「允许词表」随难度变化，回放必须跟着变——否则 easy 样本
 * 会拿 hard 的 2578 词回放，算出来的通过率比线上高，回归就失去意义。
 * 仍然接受扁平数组：`--basic <file>` 覆盖全部难度时用它。
 */
function basicListFor(basicList, level) {
  if (Array.isArray(basicList)) return basicList

  return basicList?.[level] ?? basicList?.hard ?? []
}

/** 批量回放；跳过没有正文的样本，但要在结果里留下 skipped 计数 */
export function replayAll(fixtures, basicList, budget) {
  const results = []
  const skipped = []

  for (const testCase of fixtures.cases) {
    const list = basicListFor(basicList, testCase.level)
    const result = replayCase(testCase, fixtures.users[testCase.userId], list, budget)
    if (result.kind === 'empty') skipped.push(result.id)
    else results.push(result)
  }

  return { results, skipped }
}

/**
 * 汇总：按「难度 × 篇幅」分组，顺带统计分类与历史分歧。
 *
 * `storedSaysClean` 是 §6.8 的量化口径——
 * 库里记着 0 个违规、但现在复算出 N 个的那批样本。
 */
export function summarize(results) {
  const groups = new Map()
  const categoryTotals = Object.fromEntries(
    ['abbreviation', 'proper_noun', 'wordform', 'missing_common', 'rare', 'unknown_token']
      .map((key) => [key, 0]),
  )

  let overBudget = 0
  let storedSaysClean = 0
  let unknownTotal = 0

  for (const result of results) {
    const key = `${result.level}/${result.targetWords}`
    const group = groups.get(key) ?? {
      key,
      level: result.level,
      targetWords: result.targetWords,
      cases: 0,
      accepted: 0,
      overBudget: 0,
      unknownTotal: 0,
    }

    group.cases += 1
    group.accepted += result.storedOutcome === 'accepted' ? 1 : 0
    group.overBudget += result.withinBudget ? 0 : 1
    group.unknownTotal += result.unknownCount
    groups.set(key, group)

    overBudget += result.withinBudget ? 0 : 1
    unknownTotal += result.unknownCount

    if (result.counts) {
      for (const [category, count] of Object.entries(result.counts)) {
        categoryTotals[category] = (categoryTotals[category] ?? 0) + count
      }
      // 库里记着 0，复算却有表外词——这才是「假 0」，不是「≤5 的放行」
      if (result.storedViolationsCount === 0 && result.unknownCount > 0) storedSaysClean += 1
    }
  }

  return {
    cases: results.length,
    overBudget,
    unknownTotal,
    averageUnknown: results.length ? Number((unknownTotal / results.length).toFixed(2)) : 0,
    storedSaysClean,
    categoryTotals,
    groups: [...groups.values()].sort(
      (a, b) => a.level.localeCompare(b.level) || a.targetWords - b.targetWords,
    ),
  }
}
