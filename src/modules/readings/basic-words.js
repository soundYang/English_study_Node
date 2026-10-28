import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * 分档基础词白名单（md/21 W2）。
 *
 * 三档各自回答一个不同的问题，以前混在一个文件里，改一边必然坏另一边：
 *   easy   600  —— 人工筛选（功能词 179 + 高频实词 421），产品承诺「认识这些就能读」
 *   medium 1340 —— 以 easy 为基数补到 rank ≤ 1500
 *   hard   2578 —— 再补到 rank ≤ 3000，与 `missing_common` 判定线对齐
 *
 * 难度越高，允许出现的基础词越多——这是「难度」唯一的客观含义：
 * 不是句子更长，而是它要求你认识的词更多。
 *
 * 文件缺失时逐级降档而不是抛错：少了词表只影响生成质量，
 * 不应该让服务起不来（沿用原来的容错原则）。
 */

const LEVELS = Object.freeze(['easy', 'medium', 'hard'])

const FILES = Object.freeze({
  easy: join(ROOT, 'data/basic-words.easy.json'),
  medium: join(ROOT, 'data/basic-words.medium.json'),
  hard: join(ROOT, 'data/basic-words.hard.json'),
})

function loadList(file) {
  if (!existsSync(file)) return null

  try {
    const list = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(list) ? list.filter((word) => typeof word === 'string') : null
  } catch {
    return null
  }
}

/** 从给定档开始往前降：hard → medium → easy → 空表 */
function loadFrom(level) {
  const start = LEVELS.indexOf(level)

  for (let index = Math.max(start, 0); index >= 0; index -= 1) {
    const list = loadList(FILES[LEVELS[index]])
    if (list?.length) return Object.freeze(list)
  }

  return Object.freeze([])
}

export const basicWordsByLevel = Object.freeze(
  Object.fromEntries(LEVELS.map((level) => [level, loadFrom(level)])),
)

/** 未知难度按 easy 处理：宁可少放行，也不要悄悄用到 hard 的全量表 */
export function getBasicWords(level) {
  return basicWordsByLevel[level] ?? basicWordsByLevel.easy
}

/**
 * 兼容出口：脚本与离线回放默认拿 hard 全量。
 *
 * 生成链路不要用它——必须按请求的 level 取（`getBasicWords`），
 * 否则 easy 文章会拿 hard 的 2578 词当白名单，难度形同虚设。
 */
export const basicWords = basicWordsByLevel.hard

/**
 * 179 个功能词（md/04 §二）。
 *
 * 个人基础词允许用户移除实词，但功能词不可移除：
 * 缺了 the / is / and，任何句子都写不出来。
 */
export const functionWords = Object.freeze(loadList(join(ROOT, 'data/function-words.json')) ?? [])

const FUNCTION_WORD_SET = new Set(functionWords)

/**
 * 个人基础词 = 该档基础词 − 用户标记为 `new` 的词。
 *
 * 功能词不参与减法。用户把 `the` 标成 new 只会在日志里留一条警告，
 * 不会真的让全站文章写不出来。
 *
 * @param {'easy'|'medium'|'hard'} level
 * @param {Iterable<string>} removedWords 用户 status = new 的词
 */
export function getPersonalBasicWords(level, removedWords) {
  const removed = new Set(removedWords)
  if (removed.size === 0) return getBasicWords(level)

  return getBasicWords(level).filter((word) => FUNCTION_WORD_SET.has(word) || !removed.has(word))
}

/** 用户想移除、但因为是功能词而被忽略的词，供调用方记日志 */
export function ignoredFunctionWordRemovals(removedWords) {
  return [...removedWords].filter((word) => FUNCTION_WORD_SET.has(word))
}
