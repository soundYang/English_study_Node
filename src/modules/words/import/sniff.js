import { fileParseFailed, unsupportedMediaType } from '../../../shared/errors.js'
import { TEXT_SNIFF_BYTES } from './limits.js'

/**
 * 文件类型嗅探（md/48 §3）。
 *
 * **只看文件头，不看扩展名**：改个后缀就能绕过校验的话，校验等于没有。
 * 扩展名只在一个地方参与判断——纯文本里区分 csv / txt，因为两者都是文本，
 * 魔数分不出来，而这时的误判代价只是「多切一刀」。
 */

export const FILE_KINDS = Object.freeze({
  TEXT: 'text',
  CSV: 'csv',
  DOCX: 'docx',
  XLSX: 'xlsx',
  PNG: 'png',
  JPEG: 'jpeg',
  WEBP: 'webp',
})

const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff])

/** 已知但不支持的扩展名：明确告诉用户该另存成什么，别只说「不支持」 */
const UNSUPPORTED_BY_EXTENSION = {
  doc: '不支持 Word 97-2003 的 .doc，请用 Word / WPS 另存为 .docx 再导入',
  dot: '不支持 .dot 模板，请另存为 .docx 再导入',
  dotx: '不支持 .dotx 模板，请另存为 .docx 再导入',
  docm: '不支持带宏的 .docm，请另存为 .docx 再导入',
  xls: '不支持 Excel 97-2003 的 .xls，请另存为 .xlsx 再导入',
  xlsm: '不支持带宏的 .xlsm，请另存为 .xlsx 再导入',
  xlsb: '不支持 .xlsb，请另存为 .xlsx 再导入',
  pdf: '暂不支持 PDF，请复制文字粘贴，或另存为 .docx / .xlsx 再导入',
}

/** `"Unit 3.XLSX"` → `"xlsx"`；没有扩展名时返回空串 */
export function extensionOf(fileName = '') {
  const name = String(fileName ?? '').trim().toLowerCase()
  const dot = name.lastIndexOf('.')

  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : ''
}

/**
 * @param {Buffer} buffer 原始字节
 * @param {string} fileName 只用于给出更准确的错误文案与 csv 判定
 * @returns {{ kind: string, source: string }}
 */
export function sniffFile(buffer, fileName = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw fileParseFailed('文件是空的，请换一个再试')
  }

  const ext = extensionOf(fileName)
  const blocked = UNSUPPORTED_BY_EXTENSION[ext]

  // 先按已知的不支持格式拒绝：这类文件的魔数可能是任意二进制，
  // 不拦下来会一路掉到「读不出内容」，用户得不到「该另存为什么」的提示
  if (blocked) throw unsupportedMediaType(blocked)

  if (buffer.subarray(0, 8).equals(PNG_SIG)) return { kind: FILE_KINDS.PNG, source: 'image' }
  if (buffer.subarray(0, 3).equals(JPEG_SIG)) return { kind: FILE_KINDS.JPEG, source: 'image' }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { kind: FILE_KINDS.WEBP, source: 'image' }
  }

  if (buffer.subarray(0, 4).equals(ZIP_SIG)) {
    return sniffZip(buffer)
  }

  if (looksBinary(buffer)) {
    throw unsupportedMediaType(
      '看不懂这个文件的格式，请上传 .txt / .csv / .docx / .xlsx 或图片（png / jpg / webp）',
    )
  }

  return { kind: ext === 'csv' ? FILE_KINDS.CSV : FILE_KINDS.TEXT, source: ext === 'csv' ? 'csv' : 'txt' }
}

/**
 * docx 与 xlsx 都是 zip，只能靠内部的固定路径区分。
 *
 * 扫的是原始字节而不是解压后的内容：zip 的**中央目录里文件名不压缩**，
 * `word/document.xml` 这几个字节一定原样出现在文件里，不需要解压就能判断。
 * 这比「先解压看看」安全——判断类型这一步不应该触发解压。
 *
 * @returns {{ kind: string, source: string }}
 */
function sniffZip(buffer) {
  const text = buffer.toString('latin1')

  if (text.includes('word/document.xml')) return { kind: FILE_KINDS.DOCX, source: 'docx' }
  if (text.includes('xl/workbook.xml')) return { kind: FILE_KINDS.XLSX, source: 'xlsx' }

  throw unsupportedMediaType(
    '这个压缩包里没有 Word 或 Excel 文档，请上传 .docx / .xlsx 文件',
  )
}

function looksBinary(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, TEXT_SNIFF_BYTES))

  return head.includes(0x00)
}

export const IMAGE_KINDS = new Set([FILE_KINDS.PNG, FILE_KINDS.JPEG, FILE_KINDS.WEBP])
