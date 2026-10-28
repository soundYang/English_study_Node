/**
 * 篇幅口径的唯一来源。
 *
 * 提示词、DTO 展示、校验、日志全部读这里，不允许再出现第二组 1.1 / 1.15——
 * 三处各写一套的结果是「界面写预计 220 词，提示词说 ±5%，日志按 1.4 倍告警」，
 * 用户看到的和系统实际执行的对不上。
 */

/**
 * 目标篇幅 = targetWords × TARGET_RATIO；上限 = × MAX_RATIO，超过触发重写。
 *
 * ACCEPT_RATIO 是**验收下界**，不是提示词要求：
 * 提示词仍要求 200–230，但模型写短了（实测 178/179/192/197）不值得再花一次调用
 * 去扩写——扩写比重写更容易失控。200 词的请求允许低到 170（-15%），
 * 与最初「目标 215 左右、控制在 ±15%」的产品口径一致。
 */
export const WORD_COUNT = Object.freeze({
  TARGET_RATIO: 1.1,
  MAX_RATIO: 1.15,
  ACCEPT_RATIO: 0.85,
})

/** 与 vocabulary.service.js 的切词规则保持一致：字母 + 内部撇号/连字符 */
export function countWords(article) {
  return (String(article ?? '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length
}

/**
 * 200 词的请求 → { min: 200, target: 220, max: 230, label: '200–230 词' }
 *
 * @param {number} targetWords
 * @returns {{ min: number, target: number, max: number, label: string }}
 */
export function planWordRange(targetWords) {
  const max = Math.round(targetWords * WORD_COUNT.MAX_RATIO)

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
 */
export const SENTENCE = Object.freeze({ WORDS_PER_SENTENCE: 15 })

/**
 * 每句词数由篇幅区间**反推**，而不是写死 13–16。
 *
 * 写死时 15 句 × 13 词 = 195（实测就写出过 192、197，低于下限），
 * 15 句 × 16 词 = 240（又高于上限）。按区间反推后：
 *   200 词请求 → 15 句、每句 13–15 词 → 195–225，贴着 200–230。
 *
 * @param {{ min: number, target: number, max: number }} range
 * @returns {{ sentences: number, minSentences: number, maxSentences: number, minWordsPerSentence: number, maxWordsPerSentence: number }}
 */
export function planSentenceBudget(range) {
  const sentences = Math.max(3, Math.round(range.target / SENTENCE.WORDS_PER_SENTENCE))

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
 * @returns {{ shortfall: number, sentences: number }}
 */
export function planExpandBudget(actualWords, range) {
  const shortfall = Math.max(0, range.target - actualWords)
  const sentences = Math.min(
    MAX_EXPAND_SENTENCES,
    Math.max(1, Math.ceil(shortfall / SENTENCE.WORDS_PER_SENTENCE)),
  )

  return { shortfall, sentences }
}
