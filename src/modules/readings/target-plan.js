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
 *   selectTargets?: boolean, // false = 不挑目标词（最终模式，md/30 §7.3）
 *   selectedWords?: string[],// 用户显式选中的词（md/54），已小写、去重、已校验
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
 *
 * `selectTargets: false` 是最终模式（md/30 §7.3）：1000 词的文章里挑 100 个目标词
 * 只会把正文变成「凑词练习」，反倒写不流畅。这时三个列表只剩 `supportWords`——
 * 整个池子降级成「可用词表」，提示词照样给词，只是不再要求必须出现。
 * `requiredWords` 必须一起归零：它同时是覆盖度的分母，留着 100 会让覆盖度永远 0。
 *
 * md/54：有显式选词时，选中词**全部**进入必用清单，自动补词只填剩余配额。
 * 普通模式下按 `FOCUS_RATIO` 切：前 `focusCount` 个选中词拿 ★，其余作普通目标词，
 * 这样 30 个词不会全部被要求复现 2–3 次。最终模式 / 冷启动本来没有自动目标词，
 * 选中词全作 ★——用户只选几个时，让它们都承担复习重点是合理的。
 */
export function buildTargetPlan({
  pool,
  level,
  targetWords,
  selectTargets = true,
  selectedWords = [],
}) {
  const list = Array.isArray(pool) ? pool : []
  const selected = [
    ...new Set(
      (Array.isArray(selectedWords) ? selectedWords : []).map((word) =>
        String(word).toLowerCase(),
      ),
    ),
  ]
  const selectedSet = new Set(selected)

  if (!selectTargets) {
    return {
      // 分母 = 用户选了几个；没选时仍为 0（覆盖度不产生假告警）
      requiredWords: selected.length,
      focusWords: selected,
      targetWords: [],
      supportWords: list.filter((word) => !selectedSet.has(String(word).toLowerCase())),
      repeatPlan: REPEAT_PLAN,
    }
  }

  const requiredWords = requiredTargetWords(targetWords)
  const focusCount = Math.round(requiredWords * FOCUS_RATIO)

  // S ≤ requiredWords 由 schema 保证；这里再截一次只是防御手工调用
  const selectedFocus = selected.slice(0, focusCount)
  const selectedTarget = selected.slice(focusCount, requiredWords)

  const remaining = Math.max(0, requiredWords - selected.length)
  const autoFocusCount = Math.max(0, focusCount - selectedFocus.length)
  const autoTargetCount = Math.max(0, remaining - autoFocusCount)
  const autoPool = list.filter((word) => !selectedSet.has(String(word).toLowerCase()))

  return {
    requiredWords,
    focusWords: [...selectedFocus, ...autoPool.slice(0, autoFocusCount)],
    // 变量名带 List 只是为了避免和上面的 targetWords 撞名，
    // 返回出去仍然叫 targetWords，提示词那边直接读
    targetWords: [
      ...selectedTarget,
      ...autoPool.slice(autoFocusCount, autoFocusCount + autoTargetCount),
    ],
    supportWords: autoPool.slice(autoFocusCount + autoTargetCount),
    repeatPlan: REPEAT_PLAN,
  }
}
