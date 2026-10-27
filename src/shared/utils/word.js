import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** 约 200 条高频不规则变形（went→go、children→child、better→good…） */
const IRREGULAR_FORMS = JSON.parse(
  readFileSync(join(ROOT, 'data/irregular-forms.json'), 'utf8'),
)

/** 词根短于 2 个字符没有意义，只会制造噪音候选 */
const MIN_STEM_LENGTH = 2

/** stopped → stopp → stop、running → runn → run、bigger → bigg → big */
function undouble(stem) {
  const last = stem.length - 1
  if (last <= 0) return null

  return stem[last] === stem[last - 1] ? stem.slice(0, last) : null
}

/**
 * 返回一个词可能的词根候选，按可信度排序（不规则表在前，规则在后）。
 *
 * 只做规则 + 不规则表，不查词库反推：我们的数据集没有 lemma 字段，
 * 反查只能证明「这个词本身是个词头」，不能证明「它是某个已知词的变形」。
 *
 * 宁可多给候选也不漏——调用方拿到候选后会逐个去词库里验证，
 * 误判的候选自然会被过滤掉；漏掉的候选则永远不会被找回。
 *
 * @param {string} word
 * @returns {string[]}
 */
export function resolveBaseForms(word) {
  const w = String(word ?? '').toLowerCase()
  if (w.length < 3) return []

  const forms = []
  const push = (candidate) => {
    if (!candidate || candidate === w) return
    if (candidate.length < MIN_STEM_LENGTH) return
    if (forms.includes(candidate)) return
    forms.push(candidate)
  }

  const irregular = IRREGULAR_FORMS[w]
  if (irregular) [irregular].flat().forEach(push)

  // 复数 / 第三人称单数
  if (w.endsWith('ies')) {
    push(`${w.slice(0, -3)}y`) // stories → story
    push(w.slice(0, -1)) // movies → movie
  } else if (w.endsWith('es')) {
    push(w.slice(0, -2)) // watches → watch
    push(w.slice(0, -1)) // goes → go
  } else if (w.endsWith('s') && !w.endsWith('ss')) {
    push(w.slice(0, -1)) // books → book
  }

  // 过去式 / 过去分词
  if (w.endsWith('ied')) {
    push(`${w.slice(0, -3)}y`) // tried → try
  } else if (w.endsWith('ed')) {
    const stem = w.slice(0, -2)
    push(stem) // played → play
    push(w.slice(0, -1)) // liked → like
    push(undouble(stem)) // stopped → stop
  }

  // 现在分词
  if (w.endsWith('ing')) {
    const stem = w.slice(0, -3)
    push(stem) // playing → play
    push(`${stem}e`) // making → make
    push(undouble(stem)) // running → run
  }

  // 比较级 / 最高级
  if (w.endsWith('iest')) push(`${w.slice(0, -4)}y`) // happiest → happy
  else if (w.endsWith('ier')) push(`${w.slice(0, -3)}y`) // happier → happy
  if (w.endsWith('est')) {
    push(w.slice(0, -3))
    push(undouble(w.slice(0, -3))) // biggest → big
  }
  if (w.endsWith('er')) {
    push(w.slice(0, -2))
    push(undouble(w.slice(0, -2))) // bigger → big
  }

  // 副词
  if (w.endsWith('ily')) push(`${w.slice(0, -3)}y`) // happily → happy
  else if (w.endsWith('ly')) push(w.slice(0, -2)) // quickly → quick

  return forms
}
