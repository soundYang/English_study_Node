import { basicWordByWord } from '../basic-words/basic-words.catalog.js'
import { dictionary } from '../dictionary/dictionary.loader.js'
import { getWordRank } from '../words/word-ranks.js'

/**
 * 词库分档（md/63 §4.3），与前端 `word-tiers.js` 的 COCA 阈值一致。
 *
 * 低频 8001+ 不提供入口；这里只保留高频、中频两个候选库。
 */
export const WORD_BANK_BANDS = Object.freeze({
  high: { min: 1, max: 3000, label: '高频词库' },
  mid: { min: 3001, max: 8000, label: '中频词库' },
})

let cached = null

function buildCatalog() {
  const high = []
  const mid = []

  for (const [word, entry] of dictionary) {
    // 基础词页已经覆盖 650 个最常用词，不重复进可选词库
    if (basicWordByWord.has(word)) continue

    const rank = getWordRank(word)
    if (!Number.isInteger(rank)) continue

    if (rank <= WORD_BANK_BANDS.high.max) {
      high.push({ word, rank, entry })
    } else if (rank >= WORD_BANK_BANDS.mid.min && rank <= WORD_BANK_BANDS.mid.max) {
      mid.push({ word, rank, entry })
    }
  }

  // 目录按词频升序：前端不传排序也能先看到最常用的词
  high.sort((a, b) => a.rank - b.rank)
  mid.sort((a, b) => a.rank - b.rank)

  return { high, mid }
}

/**
 * 懒加载：词典在 server 启动 / 测试 beforeAll 里才载入，
 * 模块导入时字典可能还是空的，不能在顶层直接构建。
 */
export function getWordBankCatalog() {
  if (!cached) cached = buildCatalog()
  return cached
}
