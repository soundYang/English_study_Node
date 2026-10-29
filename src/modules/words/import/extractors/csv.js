import { isHeaderRow } from './columns.js'

/**
 * CSV 抽取（md/48 §6.2）。
 *
 * **不能复用 `parseWordText()`**：它的分隔符里没有逗号，
 * `abandon,放弃` 会被当成一个整词然后判成非法，而且引号里的逗号
 * （`"放弃,抛弃"`）只有真正按 CSV 规则切列才能保住。
 *
 * 所以这里先做一次结构化解析，再把前两列当「词 / 释义」。
 */

const DELIMITERS = [',', ';', '\t']

/**
 * @param {Buffer} buffer
 * @returns {{ rows: Array<{index:number, word:string, meaning:string}>, warnings: Array }}
 */
export function extractCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '')
  const delimiter = detectDelimiter(text)
  const records = parseCsv(text, delimiter)

  const rows = []
  const warnings = []

  records.forEach((record, index) => {
    const word = String(record[0] ?? '').trim()
    const meaning = String(record[1] ?? '').trim()

    if (!word && !meaning) return
    // 只在第一条有效行上判表头：后面再出现「单词」就该当普通词处理
    if (rows.length === 0 && isHeaderRow(word, meaning)) return

    // 只有一列的行是合法的（只记单词，释义交给词库补全）
    rows.push({ index, word, meaning })
  })

  if (delimiter !== ',') {
    warnings.push({
      code: 'DELIMITER_DETECTED',
      message: `按「${delimiter === '\t' ? '制表符' : '分号'}」分隔解析`,
    })
  }

  return { rows, warnings }
}

/** 取表头行里出现次数最多的分隔符；分号主要用于欧洲区 Excel 导出 */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''

  let best = ','
  let bestCount = 0

  for (const candidate of DELIMITERS) {
    const count = firstLine.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }

  return best
}

/**
 * RFC 4180 的最小子集：逗号分隔、双引号包裹、`""` 表示一个引号、CRLF / LF 换行。
 * 不做「列数不一致时补空」「转义反斜杠」这类扩展——Excel 导出的 CSV 用不上。
 */
function parseCsv(text, delimiter) {
  const records = []
  let record = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }

      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      continue
    }

    if (char === delimiter) {
      record.push(field)
      field = ''
      continue
    }

    // CRLF 的 \r 直接丢掉；单独出现 \r 的老式换行也当换行处理
    if (char === '\r') {
      if (text[i + 1] === '\n') continue
    }

    if (char === '\n' || char === '\r') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      continue
    }

    field += char
  }

  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }

  return records
}
