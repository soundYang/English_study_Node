import { badRequest } from '../errors.js'

/**
 * 单词词形规则（md/44 §5.1）。
 *
 * 在这之前 `^[a-z'-]+$` 在 word.service / dictionary.service / dictionary.loader
 * 各抄了一份，批量导入会变成第四份。规则统一放这里，
 * 单条、批量、预检、词库加载四条路径不会再长出四种行为。
 */
export const WORD_MAX_LENGTH = 45
export const WORD_PATTERN = /^[a-z'-]+$/

/** 手填释义上限；词库义项不受这个限制（apt 有 163 字） */
export const MANUAL_MEANING_MAX_LENGTH = 100

const CHARSET_MESSAGE = `单词只能包含英文字母、连字符和撇号，且不超过 ${WORD_MAX_LENGTH} 个字符`
const PHRASE_MESSAGE = '暂不支持短语，请单个录入'

/** 去首尾空格 + 转小写；不做合法性判断 */
export function canonicalWord(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

/**
 * 只判合法性，不抛错。
 *
 * 批量导入要逐条报告失败原因，一条非法不能把整批打断，
 * 所以这里返回结果对象，单条路径再用 normalizeWordOrThrow 包一层。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, word: string }
 *   | { ok: false, word: string, reason: 'empty'|'too_long'|'phrase'|'charset', message: string }}
 */
export function checkWord(raw) {
  const word = canonicalWord(raw)

  if (!word) {
    return { ok: false, word, reason: 'empty', message: '请填写单词' }
  }

  if (word.length > WORD_MAX_LENGTH) {
    return { ok: false, word, reason: 'too_long', message: CHARSET_MESSAGE }
  }

  if (!WORD_PATTERN.test(word)) {
    // 带空格的最常见是「give up」这类短语。单独给文案：
    // 用户看到「只能包含字母」会以为是自己打错了，看到「暂不支持短语」才知道是产品限制
    const reason = /\s/.test(word) ? 'phrase' : 'charset'

    return {
      ok: false,
      word,
      reason,
      message: reason === 'phrase' ? PHRASE_MESSAGE : CHARSET_MESSAGE,
    }
  }

  return { ok: true, word }
}

/** 单条路径用：非法直接抛 400，field 固定为 word */
export function normalizeWordOrThrow(raw) {
  const result = checkWord(raw)

  if (!result.ok) throw badRequest(result.message, 'word')

  return result.word
}

/**
 * 释义校验，同样返回结果对象。
 *
 * 空释义是合法的：手填模式下允许「只记单词不记释义」，
 * 这时由服务端回查词库补快照（md/44 §5.2）。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, meaning: string } | { ok: false, meaning: string, message: string }}
 */
export function checkMeaning(raw) {
  const meaning = String(raw ?? '').trim()

  if (meaning.length > MANUAL_MEANING_MAX_LENGTH) {
    return {
      ok: false,
      meaning,
      message: `释义不能超过 ${MANUAL_MEANING_MAX_LENGTH} 个字符`,
    }
  }

  return { ok: true, meaning }
}

/** 单条路径用：非法直接抛 400，field 固定为 meaning */
export function normalizeMeaningOrThrow(raw) {
  const result = checkMeaning(raw)

  if (!result.ok) throw badRequest(result.message, 'meaning')

  return result.meaning
}
