import { resolveBaseForms } from '../../shared/utils/word.js'

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

function tokenize(article) {
  return String(article ?? '').normalize('NFKC').match(TOKEN_RE) ?? []
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

function isAllowed(word, allowed) {
  if (allowed.has(word)) return true

  // 直接命中失败时再看词形候选；resolveBaseForms 已包含不规则表
  return resolveBaseForms(word).some((form) => allowed.has(form))
}

function splitSentences(article) {
  return (String(article ?? '').match(SENTENCE_RE) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * 校验文章用词。
 *
 * @param {{ article: string, allowedWords: Set<string> | string[], names?: string[] }} params
 * @returns {{
 *   valid: boolean,
 *   unknownWords: string[],
 *   checkedWordCount: number,
 *   violations: Array<{ word: string, sentence: string }>,
 * }}
 *
 * unknownWords 去重后按出现顺序返回（错误信息只展示前 5 个）；
 * violations 与之一一对应，多带一句原文，供修正轮做局部改写。
 */
export function validateArticle({ article, allowedWords, names = [] }) {
  const allowed = new Set(
    [...allowedWords].map((word) => String(word).toLowerCase()),
  )
  const nameSet = new Set(
    names.map((name) => String(name).replace(/’/g, "'").toLowerCase()),
  )

  const sentences = splitSentences(article)
  const unknownWords = []
  const violations = []
  let checkedWordCount = 0

  for (const rawToken of tokenize(article)) {
    for (const word of expandToken(rawToken)) {
      checkedWordCount += 1

      // 人名不区分大小写放行——句首大写同理，普通词该在表里还是在表里
      if (nameSet.has(word)) continue
      if (isAllowed(word, allowed)) continue
      if (unknownWords.includes(word)) continue

      unknownWords.push(word)
      violations.push({
        word,
        sentence:
          sentences.find((sentence) =>
            sentence.toLowerCase().includes(rawToken.toLowerCase()),
          ) ?? '',
      })
    }
  }

  return {
    valid: unknownWords.length === 0,
    unknownWords,
    checkedWordCount,
    violations,
  }
}
