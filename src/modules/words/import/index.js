import { checkMeaning, checkWord } from '../../../shared/utils/word-form.js'
import { extractCsv } from './extractors/csv.js'
import { extractDocx } from './extractors/docx.js'
import { extractImage } from './extractors/image.js'
import { extractText } from './extractors/text.js'
import { extractXlsx } from './extractors/xlsx.js'
import { MAX_IMPORT_ROWS } from './limits.js'
import { FILE_KINDS, IMAGE_KINDS, sniffFile } from './sniff.js'

/**
 * 文件抽取入口（md/48 §2）。
 *
 * 这一层只做三件事：
 *   1. 嗅探类型
 *   2. 调对应的抽取器拿到「原始行」
 *   3. 逐行跑**与粘贴导入完全相同的**校验（checkWord / checkMeaning）
 *
 * 它**不碰数据库**：不认识「这个词我已经有了」「词库到上限了」，
 * 那些是 `POST /api/words/batch` 的事。写库路径永远只有一条——
 * 抽取接口只负责回答「这个文件里有哪些像单词的东西」。
 */

/**
 * @param {{ buffer: Buffer, fileName?: string }} input
 * @returns {Promise<{
 *   source: string, fileName: string, size: number,
 *   rows: Array<{index:number, word:string, meaning:string, valid:boolean, reason?:string}>,
 *   stats: { total: number, valid: number, invalid: number },
 *   truncated: boolean,
 *   warnings: Array<{code:string, message:string}>
 * }>}
 */
export async function extractWordsFromFile({ buffer, fileName = '' }) {
  const { kind, source } = sniffFile(buffer, fileName)
  const extracted = await runExtractor(kind, buffer)

  const rows = []
  const total = extracted.rows.length

  for (const raw of extracted.rows.slice(0, MAX_IMPORT_ROWS)) {
    rows.push(validateRow(raw))
  }

  return {
    source,
    fileName: String(fileName ?? '').slice(0, 200),
    size: buffer.length,
    rows,
    stats: {
      // total 是**截断前**的行数：前端要知道「还有多少没拿回来」
      total,
      valid: rows.filter((row) => row.valid).length,
      invalid: rows.filter((row) => !row.valid).length,
    },
    truncated: total > rows.length,
    warnings: extracted.warnings,
  }
}

async function runExtractor(kind, buffer) {
  if (kind === FILE_KINDS.TEXT) return extractText(buffer)
  if (kind === FILE_KINDS.CSV) return extractCsv(buffer)
  if (kind === FILE_KINDS.DOCX) return extractDocx(buffer)
  if (kind === FILE_KINDS.XLSX) return extractXlsx(buffer)
  if (IMAGE_KINDS.has(kind)) return extractImage(buffer)

  // sniffFile 已经把所有不认识的情况挡在外面，走到这里说明嗅探和分发不同步
  throw new Error(`未处理的文件类型：${kind}`)
}

/** 与 /api/words/check 同一口径：单词不合法优先，其次才是释义超长 */
function validateRow(raw) {
  const checkedWord = checkWord(raw.word)

  if (!checkedWord.ok) {
    return {
      index: raw.index,
      word: checkedWord.word || String(raw.word ?? ''),
      meaning: String(raw.meaning ?? '').slice(0, 200),
      valid: false,
      reason: checkedWord.message,
    }
  }

  const checkedMeaning = checkMeaning(raw.meaning)

  if (!checkedMeaning.ok) {
    return {
      index: raw.index,
      word: checkedWord.word,
      meaning: checkedMeaning.meaning,
      valid: false,
      reason: checkedMeaning.message,
    }
  }

  return {
    index: raw.index,
    word: checkedWord.word,
    meaning: checkedMeaning.meaning,
    valid: true,
  }
}
