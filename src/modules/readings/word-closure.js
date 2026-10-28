/**
 * 允许词表的「规则变形闭包」。
 *
 * 原有还原逻辑（`shared/utils/word.js` 的 resolveBaseForms）是**反向**的：
 * 拿到 larger 再猜它可能是 large。对 `large + r` 这种「只加一个字母」的变形，
 * 去 -er 得到 larg / larg，两个都不是 large，于是被判成表外词。
 *
 * 闭包是同一个问题的另一半：从允许词**正向**生成它会出现的形态。
 * 两者都要有——反向负责不规则表与多级后缀，正向负责比较级、-ly 这类
 * 「原形改一个字母」的规则。
 *
 * 安全边界（重要）：
 *   · 闭包只放宽「允许」，不改 `classify()`，所以不会把真违规洗成合法；
 *   · 生成的形态全部来自表内词，business 不会因为 bus 在表里就被放行——
 *     我们从不生成 -iness 这类后缀；
 *   · 闭包只在 `isAllowed` 最后一步查询，表内直接命中的路径不变。
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])
/** 结尾是这些辅音时不双写：snow→snowed、fix→fixed、play→played */
const DOUBLING_BLOCKERS = new Set(['w', 'x', 'y'])

const isConsonant = (char) => /[a-z]/.test(char) && !VOWELS.has(char)

/**
 * 是否需要双写词尾辅音（stop → stopped、big → bigger）。
 *
 * 只看「辅音-元音-辅音」结构 + 词长 ≤ 6。真正的重音判断需要音标，
 * 这里宁可笑宽一点：多生成一个 stoppest 没有代价，
 * 少生成一个 stopped 就会让一个合法句子进修复轮。
 */
function shouldDouble(word) {
  if (word.length < 3 || word.length > 6) return false
  if (word.endsWith('ss')) return false

  return (
    isConsonant(word.at(-3))
    && VOWELS.has(word.at(-2))
    && isConsonant(word.at(-1))
    && !DOUBLING_BLOCKERS.has(word.at(-1))
  )
}

/** 单个词会出现的所有规则变形，写进 out */
function addForms(out, w) {
  const add = (form) => {
    // 变形至少要有元音，否则只是把词尾堆到另一个词上
    if (form && form !== w && /[aeiouy]/.test(form)) out.add(form)
  }

  const consonantY = /[^aeiou]y$/.test(w)

  // 复数 / 第三人称单数
  if (/(s|x|z|ch|sh)$/.test(w)) add(`${w}es`)
  else if (consonantY) add(`${w.slice(0, -1)}ies`)
  else add(`${w}s`)

  // 过去式 / 过去分词
  if (w.endsWith('e')) add(`${w}d`)
  else if (consonantY) add(`${w.slice(0, -1)}ied`)
  else {
    add(`${w}ed`)
    if (shouldDouble(w)) add(`${w}${w.at(-1)}ed`)
  }

  // 现在分词
  if (w.endsWith('ie')) add(`${w.slice(0, -2)}ying`) // lie → lying
  else if (w.endsWith('e') && !w.endsWith('ee')) add(`${w.slice(0, -1)}ing`) // make → making
  else {
    add(`${w}ing`)
    if (shouldDouble(w)) add(`${w}${w.at(-1)}ing`)
  }

  // 比较级 / 最高级
  if (w.endsWith('e')) {
    add(`${w}r`) // large → larger
    add(`${w}st`) // large → largest
  } else if (consonantY) {
    add(`${w.slice(0, -1)}ier`) // happy → happier
    add(`${w.slice(0, -1)}iest`) // happy → happiest
  } else {
    add(`${w}er`)
    add(`${w}est`)
    if (shouldDouble(w)) {
      add(`${w}${w.at(-1)}er`) // big → bigger
      add(`${w}${w.at(-1)}est`) // big → biggest
    }
  }

  // 副词
  if (consonantY) add(`${w.slice(0, -1)}ily`) // happy → happily
  else if (/[^aeiou]le$/.test(w)) add(`${w.slice(0, -1)}y`) // simple → simply
  else add(`${w}ly`) // quick → quickly
}

/**
 * 由允许词集合生成变形闭包。
 *
 * @param {Iterable<string>} words 允许词（大小写不敏感）
 * @returns {Set<string>}
 */
export function buildWordClosure(words) {
  const closure = new Set()

  for (const word of words) {
    const w = String(word).toLowerCase()
    // 连字符、撇号、空格一律跳过：变形规则只作用于单个英文单词
    if (!/^[a-z]+$/.test(w)) continue

    addForms(closure, w)
  }

  return closure
}

/**
 * 连字符词按段放行：part-time、sixty-year-old、cone-shaped。
 *
 * 只拆一层（不再对每段递归），每段长度 ≥ 2——否则 `x-ray` 这种会靠
 * 单字母段混过去，而单字母本来就不该出现在正文里。
 *
 * @param {string} word 归一后的词（小写、去所有格）
 * @param {(part: string) => boolean} allowOne 单段是否放行
 */
export function isHyphenatedAllowed(word, allowOne) {
  if (!word.includes('-')) return false

  const parts = word.split('-')

  return parts.length > 1 && parts.every((part) => part.length >= 2 && allowOne(part))
}
