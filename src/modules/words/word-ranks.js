import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FILE = join(ROOT, 'data/word-ranks.json')

/**
 * COCA 词频排名表（17,629 条，见 scripts/build-word-ranks.mjs）。
 *
 * 只给后端用：`Word.cocaRank` 取值、P3 选池按难度排序都靠它。
 * 前端不加载这份数据——2.3 MB 的词库分片里已经有词频顺序，
 * 再塞一份 278 KB 的排名表没有意义。
 *
 * 文件缺失时返回空 Map 而不是抛错：没有排名只是选池时所有词都按
 * 「难度未知」处理，不应该让服务起不来。这与 basic-words.js 的处理一致。
 */
function loadWordRanks() {
  if (!existsSync(FILE)) return new Map()

  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map()

    // 只收正整数：源数据里没有 0，出现其他类型说明文件被改坏了
    return new Map(
      Object.entries(raw).filter(([, rank]) => Number.isInteger(rank) && rank > 0),
    )
  } catch {
    return new Map()
  }
}

/** 词头（小写）→ 排名。只读使用，不要在调用点 set / delete。 */
export const wordRanks = loadWordRanks()

/**
 * 查一个词在 COCA 里的排名，越小越常用。
 *
 * 查不到返回 `null`，而不是 0 或 Infinity：
 *   · 手填词、an / yourselves 这类源表里没有的词都会落空
 *   · 选池时 null 按「最简单」处理（easy 优先、hard 垫底），
 *     用 0 会被误当成最高频，用 Infinity 又会被误当成最难
 */
export function getWordRank(word) {
  const rank = wordRanks.get(String(word ?? '').trim().toLowerCase())

  return Number.isInteger(rank) ? rank : null
}
