import { parseWordText } from '../../word-import.js'

/**
 * 纯文本抽取（md/48 §6）。
 *
 * 行切分规则完全交给 `parseWordText()`——它已经覆盖制表符 / 全角空格 /
 * 两侧带空格的 `- : =` / 第一个中文字符四种写法（md/44 §5.4）。
 * 这里再写一套只会和粘贴导入产生差异。
 *
 * @param {Buffer} buffer
 * @returns {{ rows: Array<{index:number, word:string, meaning:string}>, warnings: Array }}
 */
export function extractText(buffer) {
  const text = buffer.toString('utf8')

  const rows = parseWordText(text).map((entry) => ({
    index: entry.index,
    word: entry.word,
    meaning: entry.meaning,
  }))

  return { rows, warnings: [] }
}
