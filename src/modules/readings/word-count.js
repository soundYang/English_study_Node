/**
 * 篇幅口径的唯一来源。
 *
 * 提示词、DTO 展示、校验、日志全部读这里，不允许再出现第二组 1.1 / 1.15——
 * 三处各写一套的结果是「界面写预计 220 词，提示词说 ±5%，日志按 1.4 倍告警」，
 * 用户看到的和系统实际执行的对不上。
 */

/**
 * 目标篇幅 = targetWords × TARGET_RATIO；
 * 提示词上界 = × WRITE_RATIO；重写/验收上界 = × MAX_RATIO。
 *
 * WRITE_RATIO 和 MAX_RATIO 故意差 5%（md/30 §6-1）：原来两者都是 1.15，
 * 等于「模型严格照提示词写到上限就触发整篇重写」，实测 200 词跑出 243/244、
 * 600 词跑出 691/788，每一次都是一整轮浪费。现在提示词只要 200–220，
 * 超出 230 才重写，模型有了 5% 的操作余量。
 *
 * 为什么**不**把提示词直接降到 0.95N–1.05N：md/27 §4.6 的 25 次样本显示，
 * 模型的中位产出≈提示词目标的 0.93 倍（200 词 / 目标 220 → 均值 205）。
 * 1.1 倍目标正是这个欠写的补偿项，降到 1.0 会把均值压到 0.93N，
 * 贴着 0.85N 的验收下限走，反而制造偏短样本。
 *
 * ACCEPT_RATIO 是**验收下界**，不是提示词要求：
 * 模型写短了（实测 178/179/192/197）不值得再花一次调用去扩写——扩写比重写更容易失控。
 * 200 词的请求允许低到 170（-15%），与「目标 215 左右、控制在 ±15%」的产品口径一致。
 */
export const WORD_COUNT = Object.freeze({
  TARGET_RATIO: 1.1,
  WRITE_RATIO: 1.1,
  MAX_RATIO: 1.15,
  ACCEPT_RATIO: 0.85,
})

/** 与 vocabulary.service.js 的切词规则保持一致：字母 + 内部撇号/连字符 */
export function countWords(article) {
  return (String(article ?? '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length
}

/**
 * 200 词的请求 → { min: 200, target: 220, max: 220, label: '200–220 词' }
 *
 * `max` 是**提示词里写的上限**，不是重写上界（那是 `planAcceptedRange().max`）。
 *
 * @param {number} targetWords
 * @returns {{ min: number, target: number, max: number, label: string }}
 */
export function planWordRange(targetWords) {
  const max = Math.round(targetWords * WORD_COUNT.WRITE_RATIO)

  return {
    min: targetWords,
    target: Math.round(targetWords * WORD_COUNT.TARGET_RATIO),
    max,
    label: `${targetWords}–${max} 词`,
  }
}

/**
 * 句子预算：让模型按「几句 × 每句几词」构造，而不是写完再数词。
 *
 * 实测模型数不准词（让删 35 个只删了 15 个），但数得清自己写了几句。
 * 每句按 15 词估算：220 词 → 15 句左右。
 *
 * W7：句长也是难度的一部分。原来三档共用 15 词/句，
 * 等于「easy 和 hard 的句子一样长，只是用的词不一样」——
 * 这既不符合阅读难度的直觉，也让难度同义词表在提示词里根本不起作用。
 * 不传 level 时退回 15，老调用方（回放脚本、测试）行为不变。
 */
export const SENTENCE = Object.freeze({
  WORDS_PER_SENTENCE: 15,
  BY_LEVEL: Object.freeze({ easy: 12, medium: 15, hard: 19 }),
})

/** @param {string} [level] 难度；未知或未传时用 15 词/句的旧口径 */
export function wordsPerSentenceFor(level) {
  return SENTENCE.BY_LEVEL[level] ?? SENTENCE.WORDS_PER_SENTENCE
}

/**
 * 每句词数由篇幅区间**反推**，而不是写死 13–16。
 *
 * 写死时 15 句 × 13 词 = 195（实测就写出过 192、197，低于下限），
 * 15 句 × 16 词 = 240（又高于上限）。按区间反推后：
 *   200 词请求 → 15 句、每句 13–15 词 → 195–225，贴着 200–230。
 *
 * @param {{ min: number, target: number, max: number }} range
 * @param {string} [level] 难度：只决定「每句基准词数」，句中词数仍按区间反推
 * @returns {{ sentences: number, minSentences: number, maxSentences: number, minWordsPerSentence: number, maxWordsPerSentence: number }}
 */
export function planSentenceBudget(range, level) {
  const perSentence = wordsPerSentenceFor(level)
  const sentences = Math.max(3, Math.round(range.target / perSentence))

  return {
    sentences,
    minSentences: Math.max(3, sentences - 1),
    maxSentences: sentences + 1,
    // 下界按**目标值**而不是下限反推：按 min 反推会得到 13 词/句 × 14 句 = 182，
    // 天然贴着下限走，实测就写出过 178/179。按 target 反推后中心抬到 14–15 词/句。
    minWordsPerSentence: Math.max(1, Math.floor(range.target / sentences)),
    maxWordsPerSentence: Math.max(1, Math.floor(range.max / sentences)),
  }
}

/** 每句词数的展示文案：14–15 / 15（上下界相同时不写成「15–15」） */
export function formatWordsPerSentence(budget) {
  const { minWordsPerSentence: min, maxWordsPerSentence: max } = budget

  return min === max ? `${min}` : `${min}–${max}`
}

/**
 * 验收区间：低于 targetWords × ACCEPT_RATIO 或高于 × MAX_RATIO 才算「跑偏」。
 * 只用于日志与前端展示，**不参与重试判断**——篇幅修正在 generate 里已经做完了。
 *
 * @param {number} targetWords
 * @returns {{ min: number, target: number, max: number, label: string }}
 */
export function planAcceptedRange(targetWords) {
  return {
    min: Math.round(targetWords * WORD_COUNT.ACCEPT_RATIO),
    target: Math.round(targetWords * WORD_COUNT.TARGET_RATIO),
    max: Math.round(targetWords * WORD_COUNT.MAX_RATIO),
    label: `${Math.round(targetWords * WORD_COUNT.ACCEPT_RATIO)}–${Math.round(targetWords * WORD_COUNT.MAX_RATIO)} 词`,
  }
}

/**
 * 篇幅三态（md/21 W6）。
 *
 * 判定用**验收区间**（`planAcceptedRange`），不是提示词区间：
 * 100 词请求写 90 词属于「模型没听清」，写 60 词才是「这篇不够读」。
 * 拿提示词区间判，绝大部分正常文章都会被标成 short，指标就没有信号了。
 *
 * @param {number} actualWords
 * @param {{ min: number, max: number }} acceptedRange
 * @returns {'ok' | 'short' | 'long'}
 */
export function classifyLength(actualWords, acceptedRange) {
  if (actualWords > acceptedRange.max) return 'long'
  if (actualWords < acceptedRange.min) return 'short'
  return 'ok'
}

/**
 * 单段篇幅硬上限（md/30 §6-2）。
 *
 * 段级 `maxWords` 原来只是提示词里的一个数，写超了没人管：10 段各超 10 词，
 * 1000 词的请求就多出 100 词（+10%），已经吃掉大半个容差窗口。
 * 这里给每段一个和整篇同口径的 ±15% 上限，超了**只重写这一段**。
 *
 * @param {number} maxWords 计划里给这一段的目标词数
 * @returns {number} 这一段的硬上限（含）
 */
export function segmentWordCeiling(maxWords) {
  const words = Number(maxWords)
  if (!Number.isFinite(words) || words <= 0) return 0

  // 0.15 在二进制里不精确，50 × 1.15 = 57.499999999999996，四舍五入会少 1 词。
  // 减一个极小量再向上取整，等价于「按 1.15 精确四舍五入」。
  return Math.max(1, Math.ceil(words * WORD_COUNT.MAX_RATIO - 1e-9))
}

/** 扩写轮最多补几句：按每句 15 词折算，1–3 句封顶（补太多等于重写） */
export const MAX_EXPAND_SENTENCES = 3

/**
 * 扩写预算：还差多少词、补几句。
 *
 * 目标是 `range.target`（1.1 倍）而不是验收下限，因为补到下界仍会在下一轮被判 short；
 * 但句子数封顶 3，差得多时宁可只补一轮再收，也不让扩写变成整篇重写。
 *
 * @param {number} actualWords
 * @param {{ min: number, target: number, max: number }} range 提示词区间
 * @param {string} [level] 难度：easy 的句子更短，同样差 20 词就要多补一句
 * @returns {{ shortfall: number, sentences: number }}
 */
export function planExpandBudget(actualWords, range, level) {
  const shortfall = Math.max(0, range.target - actualWords)
  const sentences = Math.min(
    MAX_EXPAND_SENTENCES,
    Math.max(1, Math.ceil(shortfall / wordsPerSentenceFor(level))),
  )

  return { shortfall, sentences }
}
