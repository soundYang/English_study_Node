import { checkMeaning, checkWord } from '../../../shared/utils/word-form.js'
import { prepareAiImport, recognizeWithAi } from './ai.js'
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
 * @param {{
 *   buffer: Buffer,
 *   fileName?: string,
 *   mode?: 'local'|'ai',
 *   userId?: string,
 * }} input
 * @returns {Promise<{
 *   source: string, fileName: string, size: number,
 *   rows: Array<{index:number, word:string, meaning:string, valid:boolean, reason?:string}>,
 *   stats: { total: number, valid: number, invalid: number },
 *   truncated: boolean,
 *   warnings: Array<{code:string, message:string}>,
 *   engine?: 'ai',
 *   ai?: { model:string, keySource:string, calls:number, inputTokens:number, outputTokens:number },
 * }>}
 */
export async function extractWordsFromFile({
  buffer,
  fileName = '',
  mode = 'local',
  userId = '',
}) {
  const { kind, source } = sniffFile(buffer, fileName)

  // L1 / L2 放在抽取之前：没资格就别解压 Word、别跑 OCR，
  // 用户也能更快看到「去接入 Key」的提示（md/49 §5）
  const aiKey = mode === 'ai' ? await prepareAiImport(userId) : null

  const extracted = await runExtractor(kind, buffer)

  if (aiKey) {
    return extractWithAi({ buffer, source, extracted, userId, aiKey, fileName })
  }

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

/**
 * AI 分支（md/49 §5）。
 *
 * AI 给的是**候选行**，这里做和本地链路完全相同的校验与截断；
 * 唯一多出来的字段是 `meaningSource`，让前端能把「AI 补的释义」标出来。
 */
async function extractWithAi({ buffer, source, extracted, userId, aiKey, fileName }) {
  const result = await recognizeWithAi({ source, buffer, extracted, userId, aiKey })

  const rows = result.items.slice(0, MAX_IMPORT_ROWS).map((item, index) => {
    const row = validateRow({ index, word: item.word, meaning: item.meaning })

    return { ...row, meaningSource: item.meaning ? 'ai' : 'missing' }
  })

  return {
    source,
    fileName: String(fileName ?? '').slice(0, 200),
    size: buffer.length,
    engine: 'ai',
    ai: {
      model: result.usage.model,
      keySource: result.usage.keySource,
      calls: result.calls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    rows,
    stats: {
      // 与本地链路同口径：total 是**截断前** AI 给出的条数
      total: result.items.length,
      valid: rows.filter((row) => row.valid).length,
      invalid: rows.filter((row) => !row.valid).length,
    },
    truncated: result.truncated,
    warnings: [
      ...extracted.warnings,
      ...result.warnings,
      {
        code: 'AI_RECOGNIZED',
        message: '内容由 AI 整理，可能有误；请逐条核对后再导入',
      },
    ],
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
