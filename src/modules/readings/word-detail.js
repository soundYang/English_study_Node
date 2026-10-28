import { findEntry } from '../dictionary/dictionary.loader.js'
import { ABBREVIATIONS } from './abbreviations.js'

/**
 * 把一个「要给用户看的单词」补全成前端能直接渲染的条目。
 *
 * 词典 → 缩写表 → 兜底，三级都查不到时 source 为 unknown，前端显示「暂无释义」。
 *
 * 两处在用：`newWords`（正文里的未学词）与生成任务的 `selectedWords`
 * （本次抽到的目标词）。形状必须一致，前端才能复用同一个单词卡片。
 *
 * @param {string} word 原形（词典检索大小写不敏感，存小写即可）
 * @returns {{word: string, phonetic: {uk: string, us: string}, senses: Array<{pos: string, meaning: string}>, source: string}}
 */
export function describeNewWord(word) {
  const entry = findEntry(word)

  if (entry) {
    return {
      word,
      phonetic: { uk: entry.phonetic?.uk ?? '', us: entry.phonetic?.us ?? '' },
      senses: (entry.senses ?? []).map(({ pos, meaning }) => ({ pos, meaning })),
      source: 'dictionary',
    }
  }

  const abbreviation = ABBREVIATIONS[word]
  if (abbreviation) {
    return {
      word,
      phonetic: { uk: '', us: '' },
      senses: [{ pos: 'abbr.', meaning: `${abbreviation.expansion}；${abbreviation.meaning}` }],
      source: 'abbreviation',
    }
  }

  return { word, phonetic: { uk: '', us: '' }, senses: [], source: 'unknown' }
}
