/**
 * 目标词计划（方案 §3.1 第 ② 步）。
 *
 * 输入是一批已经排好序的词形（`vocabulary-pool.js` 的输出），
 * 输出是「这次文章里必须用到的词」，分三档：
 *
 *   focusWords   重点词，提示词里加 ★，要求各出现 2–3 次
 *   targetWords  普通目标词，要求各出现 1–2 次
 *   supportWords 补充可用词，随便用，用来兜底可读性
 *
 * 与选池模块一样是纯函数：不认识数据库，也不认识 HTTP。
 * 分开的理由是这里的比例（35%）和复现次数会单独调参，
 * 留在 generateReading 里每改一次都要靠真实生成来验证。
 */

import { requiredTargetWords } from './vocabulary-pool.js'

/** 重点词占目标词的比例（方案 §3.2） */
export const FOCUS_RATIO = 0.35

/** 复现计划：只写进提示词，不做硬校验（方案 §8） */
export const REPEAT_PLAN = Object.freeze({
  focus: Object.freeze({ min: 2, max: 3 }),
  target: Object.freeze({ min: 1, max: 2 }),
})

/**
 * 把池子切成「重点词 / 普通目标词 / 补充可用词」三段。
 *
 * @param {{
 *   pool: string[],          // 已按「优先级 + 难度」排好序的词形
 *   level: string,           // 目前不参与切分，保留给后续按难度调复现计划
 *   targetWords: number,     // 请求里的篇幅参数（正文词数），不是目标词数
 * }} params
 * @returns {{
 *   requiredWords: number,   // 按篇幅算出的目标词数
 *   focusWords: string[],
 *   targetWords: string[],   // 普通目标词；与入参同名，取自篇幅的那个值是数字
 *   supportWords: string[],
 *   repeatPlan: typeof REPEAT_PLAN,
 * }}
 *
 * `requiredWords` 用 Math.round：300 词 → 30 × 0.35 = 10.5 → **11**；
 * 800 词 → 80 × 0.35 = 28。
 *
 * 池子可能装不下 `requiredWords` 个词（`sufficient` 为 true 但池子很小的边界）：
 * 此时后面的段位自然为空数组，不抛错——覆盖度本来只 warn，不阻断生成。
 */
export function buildTargetPlan({ pool, level, targetWords }) {
  const requiredWords = requiredTargetWords(targetWords)
  const focusCount = Math.round(requiredWords * FOCUS_RATIO)

  const list = Array.isArray(pool) ? pool : []

  return {
    requiredWords,
    focusWords: list.slice(0, focusCount),
    // 变量名带 List 只是为了避免和上面的 targetWords 撞名，
    // 返回出去仍然叫 targetWords，提示词那边直接读
    targetWords: list.slice(focusCount, requiredWords),
    supportWords: list.slice(requiredWords),
    repeatPlan: REPEAT_PLAN,
  }
}
