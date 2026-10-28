import { getPersonalBasicWords } from './basic-words.js'
import { calendarWords } from './calendar-words.js'

/**
 * 三道门禁的数字（md/20 §2、md/21 W3）。
 *
 * 这三组数字是「难度」唯一的客观定义：
 *   · requiredKnown —— 这个难度要求你认识多少词（个人词库 ∪ 该档基础表 ∪ 日历词）；
 *   · maxTargetWords —— 这个难度写多长的文章还控得住；
 *   · unknownBudget —— 允许带几个真正的生词（0 是承诺，不是失败容忍）。
 *
 * 以前这些数字只存在于 `neededVocab` 的比例换算里，用户看不到、也无法解释
 * 「为什么 hard 反而比 easy 容易」。按档写死之后，`/capacity` 和 422 文案
 * 用的是同一份常量。
 *
 * 数字仍是产品定义值：W2 的校准无法用旧语料给出结论（历史正文都在 hard
 * 全量表下生成），真实取值等 W9 付费采样。改这里只改一处，回放会立刻出现差异。
 */
export const LEVEL_LIMITS = Object.freeze({
  easy: Object.freeze({ maxTargetWords: 300, requiredKnown: 1000, unknownBudget: 0 }),
  medium: Object.freeze({ maxTargetWords: 450, requiredKnown: 1900, unknownBudget: 3 }),
  hard: Object.freeze({ maxTargetWords: 600, requiredKnown: 3778, unknownBudget: 5 }),
})

/**
 * 未知难度按 easy 处理：宁可少放行，也不要因为一个拼写错误给出更宽松的标准。
 *
 * `override` 只来自显式设置的环境变量（MAX_TARGET_WORDS），用于采样时验证
 * 「超过本档默认上限的篇幅到底写不写得出」。没设置时原样返回冻结对象，
 * 调用方拿到的仍是同一份常量，默认行为零变化。
 */
export function limitOf(level, override = null) {
  const limit = LEVEL_LIMITS[level] ?? LEVEL_LIMITS.easy
  if (!Number.isInteger(override)) return limit

  return Object.freeze({ ...limit, maxTargetWords: override })
}

/**
 * 生词预算。`override` 只来自显式设置的环境变量（MAX_UNKNOWN_WORDS），
 * 用于调试或回归时把三档压成同一个口径；没设置时按难度取。
 */
export function unknownBudgetFor(level, override = null) {
  return Number.isInteger(override) ? override : limitOf(level).unknownBudget
}

/**
 * 已知词汇量 = 个人词库(learning+mastered) ∪ 该档基础词表 ∪ 日历词。
 *
 * 生成与 /capacity 必须调用**同一个函数**：预检说能、点下去 422 的根源，
 * 就是两边各算了一遍。这里同时把个人基础词（已扣掉用户标 new 的词）返回，
 * 调用方直接拿去拼 allowedWords / 提示词，不重复算第二遍。
 *
 * @param {{
 *   level: 'easy'|'medium'|'hard',
 *   learnedWords: string[],
 *   removedBasicWords?: string[],
 * }} params
 * @returns {{
 *   personalBasicWords: string[], knownWords: number,
 *   requiredKnown: number, sufficient: boolean, shortage: number,
 * }}
 */
export function measureKnownVocabulary({ level, learnedWords, removedBasicWords = [] }) {
  const personalBasicWords = getPersonalBasicWords(level, removedBasicWords)
  const knownWords = new Set([...learnedWords, ...personalBasicWords, ...calendarWords]).size
  const { requiredKnown } = limitOf(level)

  return {
    personalBasicWords,
    knownWords,
    requiredKnown,
    sufficient: knownWords >= requiredKnown,
    shortage: Math.max(0, requiredKnown - knownWords),
  }
}
