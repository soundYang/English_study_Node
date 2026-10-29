import ExcelJS from 'exceljs'

import { fileParseFailed } from '../../../../shared/errors.js'
import { assertSafeZip } from '../zip-guard.js'
import { isHeaderRow } from './columns.js'

/**
 * Excel（.xlsx）抽取（md/48 §6.1）。
 *
 * 列映射：第 1 列 = 单词，第 2 列 = 释义，其余列忽略。
 * 第一行如果长得像表头就跳过（见 columns.js）。
 *
 * **只读缓存值，不计算公式**：exceljs 不会执行公式；没有缓存值的公式单元格
 * 会返回公式字符串（`=A1&B1`），直接当单词用会得到一堆非法词，
 * 所以这种单元格统一当空处理并记一条 warning。
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ rows: Array<{index:number, word:string, meaning:string}>, warnings: Array }>}
 */
export async function extractXlsx(buffer) {
  assertSafeZip(buffer)

  const workbook = new ExcelJS.Workbook()

  try {
    await workbook.xlsx.load(buffer)
  } catch (error) {
    throw fileParseFailed(
      'Excel 文件解析失败，可能已损坏或被加密；请用 Excel 打开后另存为 .xlsx 再试',
      null,
    )
  }

  const sheets = workbook.worksheets.filter((sheet) => hasContent(sheet))

  if (sheets.length === 0) {
    throw fileParseFailed('这个 Excel 里没有内容，请检查是不是空表')
  }

  const [sheet, ...rest] = sheets
  const rows = []
  const warnings = []
  let skippedFormula = 0

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const first = readCell(row.getCell(1))
    const second = readCell(row.getCell(2))

    if (first.formula || second.formula) {
      skippedFormula += 1
      return
    }

    const word = first.text
    const meaning = second.text

    if (!word && !meaning) return
    if (rows.length === 0 && isHeaderRow(word, meaning)) return

    rows.push({ index: rowNumber - 1, word, meaning })
  })

  if (rest.length > 0) {
    warnings.push({
      code: 'MULTIPLE_SHEETS',
      message: `只读取了工作表「${sheet.name}」，另外 ${rest.length} 个（${rest
        .map((item) => item.name)
        .join('、')}）已忽略`,
    })
  }

  if (skippedFormula > 0) {
    warnings.push({
      code: 'FORMULA_SKIPPED',
      message: `有 ${skippedFormula} 行是公式且没有缓存值，已跳过；请把公式结果复制成文本再导入`,
    })
  }

  return { rows, warnings }
}

function hasContent(sheet) {
  let found = false

  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (found) return

    for (let column = 1; column <= 2; column += 1) {
      if (readCell(row.getCell(column)).text) {
        found = true
        return
      }
    }
  })

  return found
}

/**
 * 单元格取文本。
 *
 * `cell.text` 在公式单元格上给的是公式源码，所以先看 `value`：
 * 富文本拼起来、公式取缓存 result、其余按字符串。
 */
function readCell(cell) {
  if (!cell) return { text: '', formula: false }

  const value = cell.value

  if (value === null || value === undefined) return { text: '', formula: false }

  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return { text: value.richText.map((item) => item.text ?? '').join('').trim(), formula: false }
    }

    if ('formula' in value || 'sharedFormula' in value) {
      const result = value.result

      // 没有缓存结果：当空处理，由调用方记 warning
      if (result === null || result === undefined) return { text: '', formula: true }

      return { text: String(result).trim(), formula: false, cached: true }
    }

    if (value instanceof Date) {
      return { text: value.toISOString().slice(0, 10), formula: false }
    }

    if ('text' in value) return { text: String(value.text ?? '').trim(), formula: false }

    return { text: '', formula: false }
  }

  return { text: String(value).trim(), formula: false }
}
