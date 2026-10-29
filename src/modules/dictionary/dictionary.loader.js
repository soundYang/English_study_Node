import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WORD_MAX_LENGTH, WORD_PATTERN } from '../../shared/utils/word-form.js'

const DATA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../data/dictionary',
)

/** 与 POST /words 的词形规则完全一致：先转小写再判 */
const MAX_HEADWORD_LENGTH = WORD_MAX_LENGTH
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/**
 * 进程内词库。
 *
 * dictionary   Map<小写词头, Entry>      精确查找，供 POST /words 回查快照
 * prefixIndex  Map<'a'..'z', Entry[]>    前缀检索，数组顺序 = COCA 词频顺序
 *
 * 两个 Map 都是模块级常量，加载时原地填充而不是重新赋值——
 * 这样 health 模块导入的引用始终有效，S5 之后不用改它。
 */
export const dictionary = new Map()
export const prefixIndex = new Map()

/** 加载完成时间，健康检查会返回它 */
export let loadedAt = null

/** 加载统计，供启动日志核对 */
export let dictionaryStats = null

/**
 * 三条过滤缺一不可：
 *   1. wants senses.length === 0 —— 前端 dictionary 模式要求至少一条义项
 *   2. 词头不匹配 ^[a-z'-]+$   —— and/or、his/her、he/she、sauté
 *   3. 词头超过 45 字符         —— 前端长度上限，当前数据未触发
 *
 * 注意第 2 条要先把词头转小写：MBA / VIP 这类大写词条转小写后是合法的，
 * 真正该剔除的是 sauté 这种非 ASCII，以及带斜杠的 and/or。
 */
function isSavable(word, senses) {
  if (!Array.isArray(senses) || senses.length === 0) return false
  if (word.length > MAX_HEADWORD_LENGTH) return false

  return WORD_PATTERN.test(word)
}

/**
 * 同步加载全部 26 个分片（约 2.2 MB，耗时 <100 ms）。
 * 必须在 app.listen 之前调用完，否则第一个进单词页的用户会遇到空词库。
 */
export function loadDictionary() {
  const meta = JSON.parse(readFileSync(join(DATA_DIR, 'meta.json'), 'utf8'))

  dictionary.clear()
  prefixIndex.clear()

  let rawTotal = 0
  let filtered = 0

  for (const letter of LETTERS) {
    const rows = JSON.parse(readFileSync(join(DATA_DIR, `${letter}.json`), 'utf8'))
    const bucket = []

    for (const [headword, uk, us, senses] of rows) {
      rawTotal += 1
      const key = String(headword).toLowerCase()

      if (!isSavable(key, senses)) {
        filtered += 1
        continue
      }

      const entry = {
        id: `dict_${key}`, // 仅用于溯源，不承担外键职责
        headword, // 保留原始大小写（MBA / VIP），前端保存时才转小写
        phonetic: { uk: uk || null, us: us || null }, // 某一项没有数据时为 null
        senses: senses.map(([pos, meaning]) => ({ pos: pos ?? '', meaning })),
        source: meta.source,
        fetchedAt: meta.generatedAt,
      }

      dictionary.set(key, entry)
      bucket.push(entry)
    }

    if (bucket.length > 0) prefixIndex.set(letter, bucket)
  }

  loadedAt = new Date().toISOString()
  dictionaryStats = { rawTotal, filtered, searchable: dictionary.size }

  return dictionaryStats
}

/** 按词头精确查找，POST /words 的 source=dictionary 用它回查快照 */
export function findEntry(word) {
  return dictionary.get(String(word).toLowerCase()) ?? null
}

/** 取某首字母的词频顺序数组；没有分片时返回空数组 */
export function getBucket(letter) {
  return prefixIndex.get(letter) ?? []
}
