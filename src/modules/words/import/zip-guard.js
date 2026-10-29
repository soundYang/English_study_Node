import { fileParseFailed } from '../../../shared/errors.js'
import {
  MAX_COMPRESSION_RATIO,
  MAX_UNCOMPRESSED_BYTES,
  MAX_ZIP_ENTRIES,
} from './limits.js'

/**
 * zip 炸弹防护（md/48 §8）。
 *
 * docx / xlsx 本质是 zip，5MB 的包可以声明解压后 10GB。mammoth / exceljs
 * 都会老老实实按声明解压，等内存爆掉时进程已经没了——所以**在交给解析库之前**
 * 先把中央目录读一遍，只看声明值，不解压任何一个字节。
 *
 * 只认标准的 zip32 结构；遇到 zip64 标记（0xFFFFFFFF）直接拒绝——
 * 5MB 以内的正常文档不可能是 zip64，真遇到多半是刻意构造的。
 */

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50

/** 中央目录结束记录固定 22 字节，末尾最多跟 65535 字节注释 */
const EOCD_MIN_SIZE = 22
const MAX_COMMENT_SIZE = 0xffff

/**
 * @param {Buffer} buffer
 * @returns {{ entries: number, uncompressed: number, compressed: number }}
 */
export function assertSafeZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)

  if (eocd < 0) {
    throw fileParseFailed('不是有效的 Word / Excel 文件（压缩结构损坏）')
  }

  const entries = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)

  if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw fileParseFailed('文件使用了 zip64 格式，暂不支持，请另存为标准格式后重试')
  }

  if (entries > MAX_ZIP_ENTRIES) {
    throw fileParseFailed(
      `文件内部的条目过多（${entries} 个），已拒绝解析`,
      { entries, limit: MAX_ZIP_ENTRIES },
    )
  }

  let offset = cdOffset
  let uncompressed = 0
  let compressed = 0

  for (let i = 0; i < entries; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CD_SIG) {
      throw fileParseFailed('不是有效的 Word / Excel 文件（目录结构异常）')
    }

    const entryCompressed = buffer.readUInt32LE(offset + 20)
    const entryUncompressed = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)

    if (entryUncompressed === 0xffffffff || entryCompressed === 0xffffffff) {
      throw fileParseFailed('文件使用了 zip64 格式，暂不支持，请另存为标准格式后重试')
    }

    uncompressed += entryUncompressed
    compressed += entryCompressed

    offset += 46 + nameLength + extraLength + commentLength
  }

  // 每读一条就判一次：真的炸弹可能在第一条就声明 4GB，
  // 没必要把 2000 条全走完再报错
  if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
    throw fileParseFailed(
      `文件解压后超过 ${Math.round(MAX_UNCOMPRESSED_BYTES / 1024 / 1024)}MB，已拒绝解析`,
      { uncompressed, limit: MAX_UNCOMPRESSED_BYTES },
    )
  }

  if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) {
    throw fileParseFailed('文件的压缩比异常，已拒绝解析')
  }

  return { entries, uncompressed, compressed }
}

/** 从尾部往前找 EOCD 签名；找不到返回 -1 */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE)

  for (let i = buffer.length - EOCD_MIN_SIZE; i >= earliest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i
  }

  return -1
}
