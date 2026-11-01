import { resolveBaseForms } from '../../shared/utils/word.js'
import { getWordRank } from '../words/word-ranks.js'
import { ABBREVIATION_WORDS } from './abbreviations.js'
import { buildWordClosure, isHyphenatedAllowed } from './word-closure.js'

/**
 * 词汇校验：文章里的每个词都必须能落到「用户词 + 基础词」里。
 *
 * 这是整个项目最容易被低估的一步——错了不会有异常，只会悄悄生成一篇
 * 满篇生词的文章。所以这里不做任何容忍比例，valid 就是"一个生词都没有"。
 */

/** 只认字母与撇号连写；NFKC 之后全角字母会变成半角，但撇号仍是 U+2019 */
const TOKEN_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g

/**
 * 缩写展开表。展开后逐项校验，而不是把缩写本身当词——
 * 否则 "don't" 要么被当成生词，要么被迫塞进词表。
 */
const CONTRACTIONS = Object.freeze({
  "aren't": 'are not',
  "can't": 'can not',
  // cannot 是被连写吞掉空格的 can not，不是表外词；实测它稳定被判一次生词
  cannot: 'can not',
  "couldn't": 'could not',
  "didn't": 'did not',
  "doesn't": 'does not',
  "don't": 'do not',
  "hadn't": 'had not',
  "hasn't": 'has not',
  "haven't": 'have not',
  "he'd": 'he would',
  "he'll": 'he will',
  "he's": 'he is',
  "how's": 'how is',
  "i'd": 'i would',
  "i'll": 'i will',
  "i'm": 'i am',
  "i've": 'i have',
  "isn't": 'is not',
  "it's": 'it is',
  "let's": 'let us',
  "mustn't": 'must not',
  "she'd": 'she would',
  "she'll": 'she will',
  "she's": 'she is',
  "shouldn't": 'should not',
  "that's": 'that is',
  "there's": 'there is',
  "they'd": 'they would',
  "they'll": 'they will',
  "they're": 'they are',
  "they've": 'they have',
  "wasn't": 'was not',
  "we'd": 'we would',
  "we're": 'we are',
  "we've": 'we have',
  "weren't": 'were not',
  "what's": 'what is',
  "where's": 'where is',
  "who's": 'who is',
  "won't": 'will not',
  "wouldn't": 'would not',
  "you'd": 'you would',
  "you'll": 'you will',
  "you're": 'you are',
  "you've": 'you have',
})

/** 正文切句：句末标点或换行都算断句，用于把违规词所在句反馈给模型 */
const SENTENCE_RE = /[^.!?\n]+[.!?]*/g

/**
 * 连续两个及以上的「字母 + 点」，如 U.S. / U.S.A. / e.g. / i.e.。
 *
 * 不归一的话 U.S. 会被切成 u、s 两个单字母词，双双判成生词。
 * Dr. 只有一个点，不命中这条规则，仍按原逻辑切成 dr，由缩写表放行。
 */
const DOTTED_ABBR_RE = /\b(?:[A-Za-z]\.){2,}/g

function tokenize(article) {
  return (
    String(article ?? '')
      .normalize('NFKC')
      .replace(DOTTED_ABBR_RE, (match) => match.replace(/\./g, ''))
      .match(TOKEN_RE) ?? []
  )
}

/** 撇号归一 + 展开缩写 + 去所有格，返回需要逐个校验的词 */
function expandToken(rawToken) {
  const token = rawToken.replace(/’/g, "'").toLowerCase()

  const expansion = CONTRACTIONS[token]
  if (expansion) return expansion.split(' ')

  if (token.endsWith("'s")) return [token.slice(0, -2)] // Tom's → tom
  if (token.endsWith("'")) return [token.slice(0, -1)] // dogs' → dogs

  return [token]
}

/**
 * 允许判定，三条路径按代价从低到高：
 *   1. 表内直接命中；
 *   2. 反向还原（larger → large 这类，含不规则表）；
 *   3. 正向闭包（large → larger、simple → simplest）。
 *
 * 第 3 条是新加的：反向还原对「原形只改一个字母」的变形是漏的，
 * 而闭环生成天然覆盖它。闭包只在这里用，不参与 classify()。
 */
function isAllowed(word, allowed, closure) {
  if (allowed.has(word)) return true
  if (resolveBaseForms(word).some((form) => allowed.has(form))) return true

  return closure?.has(word) ?? false
}

function splitSentences(article) {
  return (String(article ?? '').match(SENTENCE_RE) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * 断句标记：句末标点、换行，或引号/破折号收尾。
 *
 * 引号收尾也算断句，是为了让 `"Hello," she said` 里的 she 不因句首规则漏判——
 * 代价是这种位置的句中大写会被当成句首，对分类来说比反过来的误判安全。
 */
const SENTENCE_BREAK_RE = /[.!?\n]|["“”'’—]\s*$/

const EMPTY_META = Object.freeze({ midSentenceCapitalized: false, dottedAbbr: false })

/**
 * 「常用词」的判定线（COCA 排名）。
 *
 * 刻意做成模块常量而不是环境变量（`BASIC_WORDS_RANK` 已在 W10 删除）：诊断口径
 * 必须和部署环境无关，本机 .env 改一个数字就换一套分类，报告没法横向比。
 */
const COMMON_WORD_RANK = 3000

/**
 * 扫一遍**归一之前的**原文，记下每个 token 的大小写语境。
 *
 * 必须在 DOTTED_ABBR_RE 把点抹掉之前扫：抹掉之后 `U.S.` 的句点消失，
 * 断句判据全失效，后面每个词都会被当成句首词。
 *
 * 同一个 token 多次出现时按「任一次非句首大写」记——分类要回答的是
 * 「它有没有可能是个专名」，出现过一次就够。
 *
 * @returns {Map<string, { midSentenceCapitalized: boolean, dottedAbbr: boolean }>}
 */
function scanMeta(article) {
  const text = String(article ?? '').normalize('NFKC')
  const meta = new Map()

  // U.S. / e.g. 这类点号缩写的区间，区间里的字母不单独算词
  const spans = [...text.matchAll(DOTTED_ABBR_RE)].map((match) => [
    match.index,
    match.index + match[0].length,
  ])

  let prevEnd = 0
  let atStart = true

  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0]

    if (SENTENCE_BREAK_RE.test(text.slice(prevEnd, match.index))) atStart = true

    const span = spans.find(([start, end]) => match.index >= start && match.index < end)
    const key = span
      ? text.slice(span[0], span[1]).replace(/\./g, '').toLowerCase()
      : raw.toLowerCase()

    const entry = meta.get(key) ?? { midSentenceCapitalized: false, dottedAbbr: false }
    if (span) entry.dottedAbbr = true
    // 句首大写是语法，不是专名；只有非句首的大写才说明它可能是名字
    else if (!atStart && /^[A-Z]/.test(raw)) entry.midSentenceCapitalized = true

    meta.set(key, entry)
    atStart = false
    prevEnd = match.index + raw.length
  }

  return meta
}

/**
 * 只按后缀还原的朴素词形，用来发现「规则还原漏了这一条」。
 *
 * 不能拿它替代 resolveBaseForms：它会把 business 还原成 busines 这种假词根。
 * 它只在 `isAllowed` 已经失败之后用一次——朴素还原能命中允许词表，
 * 说明漏的确实是词形，而不是词表里根本没这个词。
 *
 * 比 resolveBaseForms 多一条 `-ying → -ie`（lying → lie、dying → die），
 * 那处是现有实现的真实缺口，也是这一类唯一稳定的触发点。
 */
function naiveStems(word) {
  const stems = new Set()
  const rules = [
    [/ies$/, 'y'],
    [/ied$/, 'y'],
    [/ying$/, 'ie'],
    [/es$/, ''],
    [/s$/, ''],
    [/ed$/, ''],
    [/ed$/, 'e'],
    [/ing$/, ''],
    [/ing$/, 'e'],
    [/er$/, ''],
    [/est$/, ''],
    [/ly$/, ''],
  ]

  for (const [pattern, replacement] of rules) {
    if (pattern.test(word)) stems.add(word.replace(pattern, replacement))
  }

  // 双写辅音：running → runn → run、stopped → stopp → stop
  for (const stem of [...stems]) {
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) stems.add(stem.slice(0, -1))
  }

  stems.delete(word)

  // 词根至少两个字母，否则 'as' 会还原出 'a' 这种无意义的命中
  return [...stems].filter((stem) => stem.length >= 2)
}

/**
 * 查排名，词本身没有时退到词形候选。
 *
 * COCA 词元表里只有原形：`helpers` 查不到，`helper` 排 9110。
 * 只看词本身会让所有规则复数、过去式都掉进 `unknown_token`（生造词），
 * 那是错的——它们是低频词，不是模型编出来的词。
 */
function rankOf(word) {
  const own = getWordRank(word)
  if (own !== null) return own

  for (const form of resolveBaseForms(word)) {
    const rank = getWordRank(form)
    if (rank !== null) return rank
  }

  return null
}

/**
 * 违规词分类（方案 §3.2.2）。按顺序判定，命中即停。
 *
 * 顺序不能改：先用 1、3 排掉「不是词本身的问题」，再用 4–6 判「是不是缺词」。
 * 分类只在拿到正文的那一刻做才有意义——大小写和原句之后就拿不回来了。
 *
 * @param {{ word: string, allowed: Set<string>, meta: { midSentenceCapitalized: boolean, dottedAbbr: boolean } }} params
 * @returns {'abbreviation'|'proper_noun'|'wordform'|'missing_common'|'rare'|'unknown_token'}
 */
function classify({ word, allowed, meta }) {
  // 1. 缩写：校验器本来该放行却漏了，属于校验器的 bug
  if (meta.dottedAbbr || ABBREVIATION_WORDS.includes(word)) return 'abbreviation'

  // 2. 专名：句中首字母大写。放行策略在 §4.1，这里只负责认出来
  if (meta.midSentenceCapitalized) return 'proper_noun'

  // 3. 词形：朴素还原能命中允许词表，说明问题在还原规则，不在词表。
  //    连字符词已经在放行阶段按段拆开（isHyphenatedAllowed），
  //    走到这里说明至少有一段真的不在表里，不再单独归为 wordform——
  //    否则「sixty-year-oldx」也会被算成校验器的锅。
  if (naiveStems(word).some((stem) => allowed.has(stem))) return 'wordform'

  const rank = rankOf(word)

  // 4. 常用词缺表：COCA 前 3000，加上它就能过
  if (rank !== null && rank <= COMMON_WORD_RANK) return 'missing_common'

  // 5. 真超纲：有排名但太靠后，是模型越界
  if (rank !== null) return 'rare'

  // 6. 无排名：生造词，或源表没收录的专名
  return 'unknown_token'
}

/** 所有分类取值的全集，也是 counts 的键。新增分类时只改这一处 */
export const VIOLATION_CATEGORIES = Object.freeze([
  'abbreviation',
  'proper_noun',
  'wordform',
  'missing_common',
  'rare',
  'unknown_token',
])

/**
 * 校验文章用词。
 *
 * @param {{ article: string, allowedWords: Set<string> | string[], names?: string[] }} params
 * @returns {{
 *   valid: boolean,
 *   unknownWords: string[],
 *   checkedWordCount: number,
 *   violations: Array<{
 *     token: string,        // 原文形态，含大小写
 *     normalized: string,   // 展开缩写、去所有格后参与校验的形式
 *     category: string,
 *     sentence: string,
 *   }>,
 *   counts: Record<string, number>,
 *   detectedNames: string[],
 * }}
 *
 * unknownWords 去重后按出现顺序返回（错误信息只展示前 5 个）；
 * violations 与之一一对应，多带原句和分类，供修正轮局部改写、也供失败样本做统计。
 *
 * `unknownWords` 是给老调用方的兼容面，`violations[].category` 才是诊断用的。
 * 分类永远不改变「哪些词算违规」——放行与否只看 isAllowed，改分类不影响生成行为。
 */
export function validateArticle({ article, allowedWords, names = [] }) {
  const allowed = new Set(
    [...allowedWords].map((word) => String(word).toLowerCase()),
  )
  const nameSet = new Set(
    names.map((name) => String(name).replace(/’/g, "'").toLowerCase()),
  )
  // 闭包每次校验只建一次：允许词几千个，逐词建会白烧几十倍的时间
  const closure = buildWordClosure(allowed)
  const allow = (word) => isAllowed(word, allowed, closure)

  const sentences = splitSentences(article)
  const meta = scanMeta(article)
  const unknownWords = []
  const violations = []
  const detectedNames = []
  const counts = Object.fromEntries(VIOLATION_CATEGORIES.map((category) => [category, 0]))
  let checkedWordCount = 0

  for (const rawToken of tokenize(article)) {
    // 大小写语境按原 token 查：展开缩写之后就只剩小写碎片了
    const tokenMeta = meta.get(rawToken.toLowerCase()) ?? EMPTY_META

    for (const word of expandToken(rawToken)) {
      checkedWordCount += 1

      // 人名不区分大小写放行——句首大写同理，普通词该在表里还是在表里
      if (nameSet.has(word)) continue
      if (allow(word)) continue
      // 连字符词拆一层看：sixty-year-old 的每一段都在表里就算合法（md/16 §4.3）
      if (isHyphenatedAllowed(word, allow)) continue
      if (unknownWords.includes(word)) continue

      const category = classify({ word, allowed, meta: tokenMeta })

      unknownWords.push(word)
      violations.push({
        token: rawToken,
        normalized: word,
        category,
        sentence:
          sentences.find((sentence) =>
            sentence.toLowerCase().includes(rawToken.toLowerCase()),
          ) ?? '',
      })
      counts[category] += 1

      if (category === 'proper_noun' && !detectedNames.includes(word)) {
        detectedNames.push(word)
      }
    }
  }

  return {
    valid: unknownWords.length === 0,
    unknownWords,
    checkedWordCount,
    violations,
    counts,
    detectedNames,
  }
}

/**
 * 正文里实际出现过的词形，连同它们的还原形式。
 *
 * 复习回写不能只做字符串包含：文章写的是 running，用户词库里存的是 run。
 * 所以每个出现过的 token 都把 resolveBaseForms 一并算进来，
 * 调用方只需要拿它和候选词做一次集合交集，不必逐词扫描正文。
 *
 * 与 validateArticle 用同一套 tokenize / expandToken，
 * 保证「校验算进去的词」和「回写算进去的词」永远是同一批。
 */
export function collectWordForms(article) {
  const forms = new Set()

  for (const rawToken of tokenize(article)) {
    for (const word of expandToken(rawToken)) {
      forms.add(word)
      for (const base of resolveBaseForms(word)) forms.add(base)
    }
  }

  return forms
}

/**
 * 正文里每个候选词实际出现了几次（md/56 §4.2）。
 *
 * 与 `collectWordForms` 的差别只有一条：**带次数**，且只统计传入的候选词。
 *
 * 一个 token 可能同时还原出多个形式（`ran` → `ran` / `run`），
 * 这些形式都属于**同一个** token，所以按 token 去重后再加一，
 * 否则 `ran` 这种不规则变形会把次数翻倍，用户看到的「出现 6 次」是假的。
 *
 * @param {string} article 正文
 * @param {Iterable<string>} candidates 候选词（已小写的原形）
 * @returns {Map<string, number>} 候选词 → 出现次数
 */
export function countWordForms(article, candidates) {
  const candidateSet = candidates instanceof Set ? candidates : new Set(candidates)
  const counts = new Map()

  if (!candidateSet.size) return counts

  for (const rawToken of tokenize(article)) {
    const matched = new Set()

    for (const word of expandToken(rawToken)) {
      if (candidateSet.has(word)) matched.add(word)
      for (const base of resolveBaseForms(word)) {
        if (candidateSet.has(base)) matched.add(base)
      }
    }

    for (const word of matched) counts.set(word, (counts.get(word) ?? 0) + 1)
  }

  return counts
}
