/**
 * 难度客观化（md/21 W7）。
 *
 * 「easy / medium / hard」原来是三个名字，没有任何可复现的定义：
 * 同一篇正文，两个人看会说两个难度，模型也没法被约束。
 * 这里把难度拆成六项**纯代码**指标，加权成 0–100 分。
 *
 * 只记录、不设闸门（W7 的范围）：先让每一次生成都留下一个分数，
 * 采样之后再决定每档的合理区间——用现在的成功率反推阈值等于让数据迁就实现。
 *
 * 六项指标都只依赖正文本身，同一篇正文永远得到同一个分数。
 */

import { wordRanks } from '../words/word-ranks.js'

const SENTENCE_SPLIT = /[.!?]+/
const WORD_PATTERN = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g

/** 从属连词与关系词：每个都是「一句话里套了另一层信息」的信号 */
const CLAUSE_MARKERS = new Set([
  'although', 'though', 'because', 'since', 'unless', 'until', 'while', 'whereas',
  'whether', 'when', 'whenever', 'where', 'wherever', 'if', 'after', 'before',
  'as', 'that', 'which', 'who', 'whom', 'whose', 'whoever', 'whatever',
])

/** 被动语态的规则动词形态与高频不规则过去分词（近似判断，不追求语言学完备） */
const PASSIVE_PARTICIPLES = new Set([
  'known', 'made', 'done', 'seen', 'taken', 'given', 'written', 'shown', 'held',
  'found', 'built', 'sent', 'told', 'brought', 'thought', 'kept', 'left', 'felt',
  'met', 'paid', 'read', 'sold', 'spent', 'taught', 'understood', 'won', 'lost',
  'broken', 'chosen', 'driven', 'eaten', 'fallen', 'forgotten', 'hidden', 'put',
])

const AUXILIARIES = new Set(['is', 'are', 'am', 'was', 'were', 'be', 'been', 'being'])

/**
 * 归一化区间：`min` 对应 0 分，`max` 对应 1 分，超出两端截断。
 *
 * 取值依据是「现有正文的实测范围」，不是语言学理论值：
 * easy 的文章平均句长在 8–12 词，hard 在 18–24 词。
 */
const BANDS = Object.freeze({
  avgSentenceLength: Object.freeze({ min: 8, max: 24 }),
  clauseDensity: Object.freeze({ min: 0, max: 1.5 }),
  avgWordLength: Object.freeze({ min: 3.8, max: 6.2 }),
  passiveRatio: Object.freeze({ min: 0, max: 0.4 }),
  tenseVariety: Object.freeze({ min: 1, max: 4 }),
  medianRank: Object.freeze({ min: 300, max: 3000 }),
})

/** 权重之和为 1；句长与从句密度最能区分阅读难度 */
const WEIGHTS = Object.freeze({
  avgSentenceLength: 0.25,
  clauseDensity: 0.2,
  avgWordLength: 0.15,
  passiveRatio: 0.1,
  tenseVariety: 0.15,
  medianRank: 0.15,
})

const clamp01 = (value) => Math.min(1, Math.max(0, value))
const scale = (value, { min, max }) => clamp01((value - min) / (max - min))
const round = (value, digits = 3) => Number(value.toFixed(digits))

function splitSentences(article) {
  return String(article ?? '')
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function splitWords(text) {
  return String(text ?? '').match(WORD_PATTERN) ?? []
}

/** 时态/体：只用助动词识别，规则动词的 -ed 归入 past */
function detectTenses(lower) {
  const tenses = new Set()

  if (/\b(?:is|are|am|do|does|has|have|can|must)\b/.test(lower)) tenses.add('present')
  // {3,} 是为了避开 bed / red 这类本身以 ed 结尾的短词
  if (/\b(?:was|were|did|had)\b|\b\w{3,}ed\b/.test(lower)) tenses.add('past')
  if (/\b(?:has|have|had)\s+\w+(?:ed|en)\b/.test(lower)) tenses.add('perfect')
  if (/\b(?:will|shall)\b|\bgoing to\b/.test(lower)) tenses.add('future')
  if (/\b(?:is|are|was|were)\s+\w+ing\b/.test(lower)) tenses.add('progressive')

  return tenses.size
}

function isPassive(sentence) {
  const tokens = splitWords(sentence).map((word) => word.toLowerCase())

  return tokens.some((token, index) => {
    if (!AUXILIARIES.has(token)) return false
    const next = tokens[index + 1]
    if (!next) return false

    return next.endsWith('ed') || PASSIVE_PARTICIPLES.has(next)
  })
}

/** 中位数：偶数个取中间两个的均值，不需要排序稳定性 */
function median(values) {
  if (!values.length) return null

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

/**
 * 词频中位数：同一篇文章里越罕见，排名越大、难度越高。
 * 只统计排名表里查得到的词；一个都查不到时返回 null（不参与打分）。
 */
function medianRankOf(words) {
  const ranks = words
    .map((word) => wordRanks.get(word.toLowerCase()))
    .filter((rank) => Number.isInteger(rank) && rank > 0)

  return median(ranks)
}

/**
 * @param {string} article
 * @returns {{
 *   score: number,
 *   metrics: {
 *     avgSentenceLength: number, clauseDensity: number, avgWordLength: number,
 *     passiveRatio: number, tenseVariety: number, medianRank: number|null,
 *   },
 * }}
 */
export function measureDifficulty(article) {
  const sentences = splitSentences(article)
  const words = splitWords(article)
  const lower = String(article ?? '').toLowerCase()

  const sentenceCount = Math.max(1, sentences.length)
  const wordCount = Math.max(1, words.length)

  const avgSentenceLength = round(words.length / sentenceCount)
  const clauseDensity = round(
    words.filter((word) => CLAUSE_MARKERS.has(word.toLowerCase())).length / sentenceCount,
  )
  const avgWordLength = round(
    words.reduce((sum, word) => sum + word.replace(/[^A-Za-z]/g, '').length, 0) / wordCount,
  )
  const passiveRatio = round(sentences.filter(isPassive).length / sentenceCount)
  const tenseVariety = detectTenses(lower)
  const medianRank = medianRankOf(words)

  const normalized = {
    avgSentenceLength: scale(avgSentenceLength, BANDS.avgSentenceLength),
    clauseDensity: scale(clauseDensity, BANDS.clauseDensity),
    avgWordLength: scale(avgWordLength, BANDS.avgWordLength),
    passiveRatio: scale(passiveRatio, BANDS.passiveRatio),
    tenseVariety: scale(tenseVariety, BANDS.tenseVariety),
    // 查不到排名时按「中等」算（0.5）：既不抬高也不拉低，避免整篇空转
    medianRank: medianRank === null ? 0.5 : scale(medianRank, BANDS.medianRank),
  }

  const score = Math.round(
    Object.entries(WEIGHTS).reduce(
      (sum, [key, weight]) => sum + weight * normalized[key],
      0,
    ) * 100,
  )

  return {
    score,
    metrics: {
      avgSentenceLength,
      clauseDensity,
      avgWordLength,
      passiveRatio,
      tenseVariety,
      medianRank: medianRank === null ? null : Math.round(medianRank),
    },
  }
}

/** 供测试与文档引用：同一个分数在界面上怎么读 */
export const DIFFICULTY_BANDS = Object.freeze({ BANDS, WEIGHTS })
