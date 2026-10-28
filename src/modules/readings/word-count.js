/**
 * 篇幅口径的唯一来源。
 *
 * 提示词、DTO 展示、校验、日志全部读这里，不允许再出现第二组 1.1 / 1.15——
 * 三处各写一套的结果是「界面写预计 220 词，提示词说 ±5%，日志按 1.4 倍告警」，
 * 用户看到的和系统实际执行的对不上。
 */

/** 目标篇幅 = targetWords × TARGET_RATIO；上限 = × MAX_RATIO，超过触发压缩轮 */
export const WORD_COUNT = Object.freeze({ TARGET_RATIO: 1.1, MAX_RATIO: 1.15 })

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
