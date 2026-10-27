/**
 * 转义用户输入里的正则元字符。
 *
 * 不转义的话 `q=(` 会让 new RegExp 直接抛异常变成 500，
 * `q=.` 则会命中全表——两者都是把用户输入当代码执行。
 */
export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
