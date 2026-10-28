/**
 * 基础词表的筛选规则（`build-basic-words.mjs` 与 `extend-basic-words.mjs` 共用）
 *
 * 抽出来的原因：两处各自维护一份 SENSITIVE，迟早会有一边被改掉。
 * 这里只搬位置，不改规则——`build-basic-words.mjs --rank 3000` 的输出不变。
 */

/** 释义里出现这些词就不当基础词：阅读材料里用不上，孩子看到也不合适 */
export const SENSITIVE = [
  '性交',
  '性行为',
  '性欲',
  '色情',
  '妓',
  '娼',
  '强奸',
  '阴茎',
  '阴道',
  '精液',
  '肛门',
  '阳具',
  '屎',
  '尿',
  '屁',
  '他妈',
  '妈的',
  '该死',
  '见鬼',
  '诅咒',
  '吸毒',
  '毒品',
  '大麻',
  '可卡因',
  '海洛因',
  '鸦片',
  '安非他命',
]

/** 缩写/称谓：写文章时不会当普通词用 */
export const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'pm', 'tv'])

/**
 * 源数据里全大写但其实是普通词的条目。
 * 不列白名单的话，"true" 会因为没有小写词头被当成专有名词误杀。
 */
export const PROPER_NOUN_KEEP = new Set(['true'])

/** 只允许纯字母和撇号：连字符复合词、带点缩写、带重音的借词一律不要 */
export const SHAPE_RE = /^[A-Za-z]+(?:'[A-Za-z]+)?$/

/** 只看第一条释义：force / age / drug / couple 的敏感义项都是靠后的冷门用法 */
export function isSensitiveMeaning(meaning) {
  return SENSITIVE.some((keyword) => String(meaning ?? '').includes(keyword))
}
