import { getPersonalBasicWords } from './basic-words.js'
import { calendarWords } from './calendar-words.js'

/**
 * 每个难度的两个数字（md/20 §2、md/21 W3、md/30 §7）。
 *
 *   · maxTargetWords —— 这个难度写多长的文章还控得住；
 *   · unknownBudget  —— 允许带几个真正的生词（0 是承诺，不是失败容忍）。
 *
 * 原来的第三个数 `requiredKnown`（1000 / 1900 / 3778）已于 md/30 §7 删除：
 * 它不随篇幅变，实测 600 词只要 704 个已知词，而它要求 3778 个（高 5.2 倍）。
 * 现在篇幅 ↔ 词汇量的门槛由 `capacity-table.js` 按 `minKnown(N)` 给，
 * 本文件只保留「与篇幅无关」的那两项。
 */
export const LEVEL_LIMITS = Object.freeze({
  easy: Object.freeze({ maxTargetWords: 300, unknownBudget: 0 }),
  medium: Object.freeze({ maxTargetWords: 450, unknownBudget: 3 }),
  hard: Object.freeze({ maxTargetWords: 600, unknownBudget: 5 }),
})

/**
 * 未知难度按 easy 处理：宁可少放行，也不要因为一个拼写错误给出更宽松的标准。
 *
 * `override` 只来自显式设置的环境变量（MAX_TARGET_WORDS），用于采样时验证
 * 「超过本档默认上限的篇幅到底写不写得出」。没设置时原样返回冻结对象，
 * 调用方拿到的仍是同一份常量，默认行为零变化。
 *
 * ⚠️ 线上生成走 `capacity-table.js` 的 `maxTargetWordsFor()`（最终模式会把它抬到 1000），
 * 这里只给仍在按固定档位跑的脚本用。新代码不要直接读 `limitOf().maxTargetWords`。
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
 * 只返回两个数，不再返回 `sufficient` / `shortage`：
 * 「够不够」取决于请求的篇幅（`capacity-table.js` 的 `minKnownFor(N)`），
 * 本函数不知道 N，就不该替调用方判断。
 *
 * @param {{
 *   level: 'easy'|'medium'|'hard',
 *   learnedWords: string[],
 *   removedBasicWords?: string[],
 * }} params
 * @returns {{ personalBasicWords: string[], knownWords: number }}
 */
export function measureKnownVocabulary({ level, learnedWords, removedBasicWords = [] }) {
  const personalBasicWords = getPersonalBasicWords(level, removedBasicWords)
  const knownWords = new Set([...learnedWords, ...personalBasicWords, ...calendarWords]).size

  return { personalBasicWords, knownWords }
}
