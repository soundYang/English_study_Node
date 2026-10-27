import { ApiError, ERROR_CODES } from '../../shared/errors.js'
import { resolveBaseForms } from '../../shared/utils/word.js'
import { getBucket } from './dictionary.loader.js'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const MIN_LIMIT = 1
const MAX_QUERY_LENGTH = 45
const WORD_PATTERN = /^[a-z'-]+$/
/** 只有够长才做词形还原，否则 "goes" 这种短词的候选噪音太大 */
const BASE_FORM_MIN_LENGTH = 3

/** limit 非法值一律回落默认值，不报 400——契约要求的是 clamp 而不是拒绝 */
function clampLimit(raw) {
  const value = Number.parseInt(raw, 10)

  if (!Number.isFinite(value)) return DEFAULT_LIMIT

  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, value))
}

/** 白名单构造，phonetic 永远是对象（候选列表直接读 phonetic.uk） */
function toDictionaryDto(entry) {
  return {
    id: entry.id,
    headword: entry.headword,
    phonetic: { uk: entry.phonetic.uk, us: entry.phonetic.us },
    senses: entry.senses.map((sense) => ({ pos: sense.pos, meaning: sense.meaning })),
    source: entry.source,
    fetchedAt: entry.fetchedAt,
  }
}

/**
 * GET /api/dictionary/search
 *
 * 两轮检索：
 *   1. 本字母分片内 headword 前缀匹配，数组顺序即词频顺序
 *   2. 结果不足 limit 且查询词够长时，做词形还原，用词根再前缀匹配一轮
 *
 * 不做包含匹配（ban → urban）：数据按首字母分片，包含匹配要全表扫描，
 * 而补全场景下用户期望的就是前缀命中。
 */
export function searchDictionary({ q, limit }) {
  const keyword = String(q ?? '')
    .trim()
    .toLowerCase()

  if (
    keyword.length < 1 ||
    keyword.length > MAX_QUERY_LENGTH ||
    !WORD_PATTERN.test(keyword)
  ) {
    throw new ApiError(
      400,
      ERROR_CODES.INVALID_QUERY,
      '查询词只能包含英文字母、连字符和撇号，长度 1–45',
    )
  }

  const max = clampLimit(limit)
  const seen = new Set()
  const picked = []

  /** @returns {boolean} 是否已经够数 */
  const add = (entry) => {
    if (seen.has(entry.id)) return false

    seen.add(entry.id)
    picked.push(entry)

    return picked.length >= max
  }

  for (const entry of getBucket(keyword[0])) {
    if (!entry.headword.toLowerCase().startsWith(keyword)) continue
    if (add(entry)) break
  }

  // 完全匹配排最前；同层内保持词频顺序（Array.prototype.sort 在 V8 里是稳定的）
  const rank = (entry) => (entry.headword.toLowerCase() === keyword ? 0 : 1)
  picked.sort((a, b) => rank(a) - rank(b))

  if (picked.length < max && keyword.length >= BASE_FORM_MIN_LENGTH) {
    for (const base of resolveBaseForms(keyword)) {
      if (picked.length >= max) break

      for (const entry of getBucket(base[0])) {
        if (!entry.headword.toLowerCase().startsWith(base)) continue
        if (add(entry)) break
      }
    }
  }

  return { query: keyword, items: picked.map(toDictionaryDto) }
}
