import { resolveBaseForms } from '../../shared/utils/word.js'
import { countWords } from './word-count.js'

/**
 * 目标词真实覆盖度（md/21 W5 / md/14 §3）。
 *
 * 「目标词必须全部出现」在这之前只是提示词里的一句话，没有任何校验。
 * 这个模块把正文与目标词计划对照，输出六项可比的指标；
 * **M2 阶段只记录和 warn，不触发修复**——修复要多一轮调用，先用数据确认划算。
 *
 * 纯函数：不认识数据库，也不认识 HTTP。
 */

const TOKEN_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g

/** 与 countWords 同一套切词；归一撇号后小写，用于按词元计数 */
function tokenize(article) {
  return (String(article ?? '').normalize('NFKC').match(TOKEN_RE) ?? []).map((token) =>
    token.replace(/’/g, "'").toLowerCase(),
  )
}

/** 出现超过这个次数就视为「凑词痕迹」 */
export const OVERUSED_THRESHOLD = 6

/** 重点词的复现目标（与 target-plan.js 的 REPEAT_PLAN.focus 一致） */
export const FOCUS_REPEAT_MIN = 2

const ratio = (numerator, denominator) =>
  denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0

/**
 * @param {{
 *   article: string,
 *   focusWords?: string[],     // 带 ★ 的重点词
 *   targetWords?: string[],    // 普通目标词
 *   requiredWords?: number,    // 计划的目标词数（分母）
 * }} params
 * @returns {{
 *   coverageRate: number,      // 出现过的不同目标词 / requiredWords
 *   totalOccurrences: number,  // 目标词总出现次数
 *   focusRepeatRate: number,   // 复现 ≥2 次的重点词 / 重点词数
 *   unused: string[],          // 一次都没出现的目标词
 *   overused: string[],        // 出现 > 6 次的词（凑词痕迹）
 *   densityScore: number,      // 目标词 token / 正文 token（应接近 0.1）
 * }}
 */
export function measureTargetCoverage({
  article,
  focusWords = [],
  targetWords = [],
  requiredWords = 0,
}) {
  const targets = [...new Set([...focusWords, ...targetWords].map((word) => String(word).toLowerCase()))]
  const targetSet = new Set(targets)
  const counts = new Map(targets.map((word) => [word, 0]))
  const tokens = tokenize(article)

  for (const token of tokens) {
    // 词形变化也计入：正文写 runs / running，目标词是 run
    const forms = new Set([token, ...resolveBaseForms(token)])
    const hit = targets.find((word) => forms.has(word))
    if (hit) counts.set(hit, counts.get(hit) + 1)
  }

  const used = targets.filter((word) => counts.get(word) > 0)
  const focusSet = new Set(focusWords.map((word) => String(word).toLowerCase()))
  const focusRepeated = targets.filter(
    (word) => focusSet.has(word) && counts.get(word) >= FOCUS_REPEAT_MIN,
  )

  return {
    coverageRate: ratio(used.length, requiredWords),
    totalOccurrences: targets.reduce((sum, word) => sum + counts.get(word), 0),
    focusRepeatRate: ratio(focusRepeated.length, focusSet.size),
    unused: targets.filter((word) => counts.get(word) === 0),
    overused: targets.filter((word) => counts.get(word) > OVERUSED_THRESHOLD),
    densityScore: ratio(
      targets.reduce((sum, word) => sum + counts.get(word), 0),
      countWords(article),
    ),
  }
}
