/**
 * 分段计划（md/20 §5.3 / md/21 W4）。
 *
 * 模型只负责「每段写什么」，不负责「目标词怎么分」——
 * 划分、补齐、篇幅校正是纯代码，模型输出不合法时也不需要再调一次。
 * 理由很直接：目标词覆盖是硬约束，交给抽样去满足就是赌概率。
 */

/** 每段的目标词数：60 词/段是 md/20 §5.3 的经验值 */
export const SEGMENT_RULE = Object.freeze({
  WORDS_PER_SEGMENT: 60,
  MIN_SEGMENTS: 3,
  MAX_SEGMENTS: 10,
  MIN_SEGMENT_WORDS: 20,
  MAX_SEGMENT_WORDS: 400,
})

/** 段数 = ceil(targetWords / 60)，夹在 [3, 10]：太少的段等于没分段，太多则上下文断裂 */
export function planSegmentCount(targetWords) {
  const count = Math.ceil(Number(targetWords) / SEGMENT_RULE.WORDS_PER_SEGMENT)

  return Math.min(
    SEGMENT_RULE.MAX_SEGMENTS,
    Math.max(SEGMENT_RULE.MIN_SEGMENTS, count || 0),
  )
}

const fallbackGoal = (index) => `第 ${index} 段：继续故事，保持人物与时间地点连贯。`

function toMaxWords(value, fallback) {
  const number = Number(value)

  if (!Number.isInteger(number)) return fallback
  if (number < SEGMENT_RULE.MIN_SEGMENT_WORDS) return fallback
  if (number > SEGMENT_RULE.MAX_SEGMENT_WORDS) return fallback

  return number
}

/**
 * 把模型返回的计划修正成可直接执行的计划。
 *
 * 修正四件事（全部不调模型）：
 *   1. 段数不足 → 补空段，目标用兜底句；
 *   2. mustUse 只保留【目标词】里的词，跨段去重；
 *   3. 漏掉的目标词均摊进当前 mustUse 最少的段；
 *   4. 各段 maxWords 之和跑出篇幅区间 → 按比例缩放。
 *
 * @param {{
 *   raw: unknown,                  // 模型原始 JSON，可能是 null 或形状不对
 *   targetWords: number,           // 篇幅参数（正文词数）
 *   targetWordList: string[],      // 必须覆盖的全部目标词（重点词 + 普通目标词）
 *   range: { min: number, target: number, max: number },
 * }} params
 * @returns {Array<{ id: number, goal: string, maxWords: number, mustUse: string[] }>}
 */
export function buildSegmentPlan({ raw, targetWords, targetWordList, range }) {
  const count = planSegmentCount(targetWords)
  const fallbackWords = Math.max(1, Math.round(range.target / count))
  const rawSegments = Array.isArray(raw?.segments) ? raw.segments : []
  const targetSet = new Set(targetWordList.map((word) => String(word).toLowerCase()))

  const segments = Array.from({ length: count }, (_, index) => {
    const item = rawSegments[index] ?? {}
    const goal = typeof item.goal === 'string' ? item.goal.trim() : ''

    return {
      id: index + 1,
      goal: goal ? goal.slice(0, 200) : fallbackGoal(index + 1),
      maxWords: toMaxWords(item.maxWords, fallbackWords),
      mustUse: [],
    }
  })

  // 先收下模型给的划分，跨段去重；只认目标词，模型偶尔会把基础词也塞进来
  const assigned = new Set()
  for (const [index, segment] of segments.entries()) {
    const words = Array.isArray(rawSegments[index]?.mustUse) ? rawSegments[index].mustUse : []

    for (const word of words) {
      const normalized = String(word).toLowerCase().trim()
      if (!targetSet.has(normalized) || assigned.has(normalized)) continue

      segment.mustUse.push(normalized)
      assigned.add(normalized)
    }
  }

  // 代码补齐：漏掉的目标词逐个放进当前mustUse 最少的段（平票放进靠前的段）
  for (const word of targetSet) {
    if (assigned.has(word)) continue

    const target = segments.reduce((min, segment) =>
      segment.mustUse.length < min.mustUse.length ? segment : min,
    )
    target.mustUse.push(word)
    assigned.add(word)
  }

  // 篇幅：模型给的总和不在区间内时按比例缩放。缩放后仍可能差一两个词，
  // 那属于可接受误差——段落篇幅本来就只是提示词里的软目标。
  const sum = segments.reduce((acc, segment) => acc + segment.maxWords, 0)
  if (sum > 0 && (sum < range.min || sum > range.max)) {
    const factor = range.target / sum
    for (const segment of segments) {
      segment.maxWords = Math.max(
        SEGMENT_RULE.MIN_SEGMENT_WORDS,
        Math.round(segment.maxWords * factor),
      )
    }
  }

  return segments
}
