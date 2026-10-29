/**
 * 「第一行是不是表头」的判定（md/48 §6.1）。
 *
 * 表格导入最常见的失败不是解析不出来，而是把表头当成了单词：
 * 用户打开预览看到第一个词是「单词」，会以为整个功能坏了。
 *
 * 只认很窄的一组写法：宁可漏判（用户自己删掉表头那一行），也不要误判——
 * 把一个真单词当表头丢掉，用户根本发现不了。
 */

const WORD_HEADERS = /^(单词|词汇|英文|英文单词|word|words|english)$/i
const MEANING_HEADERS = /^(释义|意思|中文|中文释义|翻译|解释|meaning|translation|definition)$/i

/**
 * @param {string} word 第一列
 * @param {string} meaning 第二列
 * @returns {boolean} 是否该跳过这一行
 */
export function isHeaderRow(word, meaning) {
  const first = String(word ?? '').trim()
  const second = String(meaning ?? '').trim()

  if (!first) return false
  if (!WORD_HEADERS.test(first)) return false

  // 只写「单词」、第二列空着，也算表头
  return second === '' || MEANING_HEADERS.test(second)
}
