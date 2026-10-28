import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * 基础词白名单。
 *
 * 历史（md/21 W2）：曾经按难度分三档，medium/hard 用 COCA 排名自动扩容
 * （medium 补到 rank ≤ 1500、hard 补到 rank ≤ 3000）。
 *
 * 现状（2026-10-28 产品决定）：**基础词汇只有 easy 这 600 多个**
 * （功能词 179 + 人工筛选的高频实词 421，排除了公司/政务/死亡等成人话题词）。
 * 三份文件仍会加载，但生成链路统一走 `getBasicWords()`，三档取到的都是同一份。
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

/**
 * 全档统一用 easy 那一份（2026-10-28 产品决定：基础词汇就是这 600 多个）。
 *
 * medium / hard 两份文件仍然保留并继续加载（`basicWordsByLevel` 的出口不变），
 * 但**生成链路不再按难度取表**——三档共用同一份白名单。
 *
 * 这样做把「难度」的承载物收敛到三处：
 *   · `capacity-table.js` 的 `minKnownFor(N)` —— 写这么长要认识多少词（随篇幅走）
 *   · `LEVEL_LIMITS.maxTargetWords` —— 写多长（最终模式另由 `maxTargetWordsFor` 给）
 *   · `LEVEL_LIMITS.unknownBudget`  —— 允许带几个生词
 * 不再有「基础表变大 ⇒ 难度变大」这个隐含杠杆。
 *
 * 旧 B 门（`requiredKnown` = 3778，个人词库要攒到 3159）已于 md/30 §7 删除：
 * 它不随篇幅变化，实测 600 词只要 704 个已知词。基础表 600 带来的「地板」效应
 * 现在只体现在 `knownWords = personalWords + 618` 这一层。
 *
 * 参数保留只是为了让旧的调用点与测试不必同步改签名。
 */
export function getBasicWords() {
  return basicWordsByLevel.easy
}

/**
 * 历史口径的 hard 全量表（2578 词）。**只给重建旧样本的脚本用**。
 *
 * 名字刻意写得难看：它曾经叫 `basicWords`，被当成「基础词」的默认值，
 * 结果两处脚本各按不同口径算 allowedWords，算出来的生词数根本没有可比性。
 * 现在生成链路一律走 `getBasicWords()`（三档同一份 600），
 * 需要按难度取表的地方用 `basicWordsByLevel[level]`；
 * 只有在「还原历史 fixture / 补算修复前样本」时，才允许用这张旧表。
 */
export const legacyHardBasicWords = basicWordsByLevel.hard

/**
 * 179 个功能词（md/04 §二）。
 *
 * 个人基础词允许用户移除实词，但功能词不可移除：
 * 缺了 the / is / and，任何句子都写不出来。
 */
export const functionWords = Object.freeze(loadList(join(ROOT, 'data/function-words.json')) ?? [])

const FUNCTION_WORD_SET = new Set(functionWords)

/**
 * 个人基础词 = 基础词（全档同一份 600）− 用户标记为 `new` 的词。
 *
 * `level` 参数保留但不再影响取哪份词表，见 `getBasicWords` 的说明。
 *
 * 功能词不参与减法。用户把 `the` 标成 new 只会在日志里留一条警告，
 * 不会真的让全站文章写不出来。
 *
 * @param {'easy'|'medium'|'hard'} level 仅用于保持调用签名，当前不影响结果
 * @param {Iterable<string>} removedWords 用户 status = new 的词
 */
export function getPersonalBasicWords(level, removedWords) {
  const removed = new Set(removedWords)
  if (removed.size === 0) return getBasicWords()

  return getBasicWords().filter((word) => FUNCTION_WORD_SET.has(word) || !removed.has(word))
}

/** 用户想移除、但因为是功能词而被忽略的词，供调用方记日志 */
export function ignoredFunctionWordRemovals(removedWords) {
  return [...removedWords].filter((word) => FUNCTION_WORD_SET.has(word))
}
