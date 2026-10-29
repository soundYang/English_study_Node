import { fileParseFailed } from '../../../../shared/errors.js'
import { parseWordText } from '../../word-import.js'
import { assertSafeZip } from '../zip-guard.js'
import { isHeaderRow } from './columns.js'

/**
 * Word（.docx）抽取（md/48 §6.3）。
 *
 * **不用 `mammoth.extractRawText`**：它把每个段落（包括表格单元格）都当成
 * 独立段落输出，`abandon | 放弃` 两列的表格会变成两行——一行是单词，
 * 一行是纯中文的「非法词」。而词表最常见的排版就是表格。
 * 这里改用 `convertToHtml`，把同一行的单元格用制表符接回去，
 * 正好落进 `parseWordText()` 的第一条切分规则。
 *
 * 已知取不到的情况：文字放在**文本框**（`w:txbxContent`）里时 mammoth 会跳过。
 * 这时结果是 0 行，上层给「没读到内容」的提示，而不是静默返回空列表。
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ rows: Array<{index:number, word:string, meaning:string}>, warnings: Array }>}
 */
export async function extractDocx(buffer) {
  // 先验压缩结构：加密的、损坏的、zip 炸弹在这里就被挡下，
  // 不会让 mammoth 把内存吃光再报错
  assertSafeZip(buffer)

  const mammoth = await import('mammoth')

  let html

  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        // 图片不必内联成 base64：我们只取文字。默认行为会把图片编码进 HTML 字符串，
        // 一个带图的 5MB 文档能膨胀到十几 MB，再被下面的正则整体扫一遍
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      },
    )

    html = result?.value ?? ''
  } catch (error) {
    throw fileParseFailed(
      'Word 文件解析失败，可能已损坏或被加密；请用 Word 打开后另存为 .docx 再试',
      null,
    )
  }

  const rows = []

  for (const entry of parseWordText(htmlToText(html))) {
    // 表格排版的第一行通常是「单词 | 释义」；与 csv / xlsx 同一口径，
    // 只看第一行，后面再出现「单词」就当普通词交给用户自己删
    if (rows.length === 0 && isHeaderRow(entry.word, entry.meaning)) continue

    rows.push({ index: entry.index, word: entry.word, meaning: entry.meaning })
  }

  const warnings = []

  if (rows.length === 0) {
    warnings.push({
      code: 'NO_TEXT',
      message: '这个 Word 里没读到文字。如果内容在文本框或图片里，请改成正文或直接粘贴文本',
    })
  }

  return { rows, warnings }
}

/** 单元格结束 → 制表符 */
const CELL_END = /<\/t[dh]>/gi
/** 段落级结束 → 换行；<br> 同理 */
const BLOCK_END = /<\/(?:p|li|h[1-6]|blockquote|div|pre)>/gi
const LINE_BREAK = /<br\s*\/?>/gi
const TAG = /<[^>]*>/g

/**
 * mammoth 输出的 HTML 只有一小撮标签（p / table / tr / td / strong / em / ul / li / br / img），
 * 所以这里用正则足够——换成通用 HTML 解析器反而要把整个 cheerio 拖进来。
 *
 * 关键一步是**先按 `<tr>` 整行压平**再处理其余标签：单元格里的 `<p>` 也会
 * 产生换行，如果先全局替换 `</p>`，`<td><p>abandon</p></td>` 就变成
 * 「abandon」和「\t放弃」两行，单词和释义又分家了。
 */
export function htmlToText(html) {
  const text = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // 表格行必须**先**压成一行：单元格里的 <p> 也会产生换行，
    // 先把它换成换行符的话，`<td><p>abandon</p></td>` 会变成
    // 「abandon」和「\t放弃」两行，单词和释义又分家了
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (match, row) => `${flattenRow(row)}\n`)
    .replace(LINE_BREAK, '\n')
    .replace(BLOCK_END, '\n')
    .replace(TAG, '')
    .replace(/&[a-z#0-9]+;/gi, decodeEntity)

  return text
    .split('\n')
    .map(collapseCells)
    .filter(Boolean)
    .join('\n')
}

/** 一行表格 → `单元格\t单元格`；单元格内的段落 / 换行用空格代替 */
function flattenRow(row) {
  return row
    .replace(CELL_END, '\t')
    .replace(LINE_BREAK, ' ')
    .replace(BLOCK_END, ' ')
    .replace(TAG, '')
    .replace(/[ \t]*\t[ \t]*/g, '\t')
}

/**
 * 一行里的多个单元格只留前两个：与 Excel 一样「第 1 列单词、第 2 列释义，其余忽略」。
 * 空单元格（合并单元格、尾部空列）直接丢掉，避免 `abandon\t\t` 这种噪声。
 */
function collapseCells(line) {
  const cells = line
    .split('\t')
    .map((cell) => cell.trim())
    .filter(Boolean)

  return cells.slice(0, 2).join('\t')
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
}

function decodeEntity(entity) {
  const name = entity.slice(1, -1).toLowerCase()
  const named = NAMED_ENTITIES[name]

  if (named !== undefined) return named

  if (name.startsWith('#x')) return codePoint(Number.parseInt(name.slice(2), 16))
  if (name.startsWith('#')) return codePoint(Number.parseInt(name.slice(1), 10))

  // 不认识的实体原样留着：它是文本的一部分，不是我们要处理的
  return entity
}

function codePoint(value) {
  return Number.isFinite(value) ? String.fromCodePoint(value) : ''
}
