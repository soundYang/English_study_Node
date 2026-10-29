/**
 * 在交给 OCR 之前读出图片尺寸（md/48 §8）。
 *
 * 为什么必须单独做这一步：**文件体积挡不住像素体积**。
 * 一张 20000×20000 的纯白 PNG 压完只有几百 KB，5MB 上限拦不住它；
 * 但 leptonica 解码时要按 `宽 × 高 × 每像素字节` 分配内存——
 * 灰度 400MB、RGBA 1.6GB，两个 worker 一起就是几个 GB。
 * WASM 的内存属于进程级，爆掉的后果不是「这次识别失败」，
 * 而是**整个 API 进程被系统杀掉**，连错误日志都来不及写。
 *
 * 只读文件头，不解码：
 *   PNG  → IHDR
 *   JPEG → 扫到 SOFn 段
 *   WEBP → VP8X / VP8L / VP8 三种头
 * 读不出来就返回 null（放行）——这个函数是防护，不是校验器，
 * 不能因为一个奇怪的文件头把正常图片也挡在外面。
 */

import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from './limits.js'

/**
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number } | null}
 */
export function readImageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null

  if (buffer.readUInt32BE(0) === 0x89504e47) return readPng(buffer)
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return readJpeg(buffer)
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF') return readWebp(buffer)

  return null
}

/**
 * 是否超出可处理的尺寸。
 *
 * 上限取 4000 万像素（约等于 6300×6300）：手机原图 12MP、4K 截图 8MP、
 * 一万像素高的长截图也都在线内；超过这个量级的「单词图片」基本是误传了别的图。
 *
 * @param {{ width: number, height: number }} size
 */
export function isTooLarge(size) {
  if (!size) return null

  const { width, height } = size

  if (width * height > MAX_IMAGE_PIXELS || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    return size
  }

  return null
}

/** PNG：8 字节签名 + 4 字节长度 + "IHDR" + 宽(4) + 高(4)，全部大端 */
function readPng(buffer) {
  if (buffer.length < 24 || buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null

  // 0 宽高是非法值，当读不出来处理
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)

  return width > 0 && height > 0 ? { width, height } : null
}

/** SOFn 段里带尺寸；C4(DHT)/C8(JPG)/CC(DAC) 不是 SOF，必须排除 */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function readJpeg(buffer) {
  let offset = 2

  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      // 填充字节（0xFF 0xFF）之外出现非标记字节，说明结构已乱，别再猜
      offset += 1
      continue
    }

    const marker = buffer[offset + 1]

    // 无长度的独立标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }

    // SOS 之后是熵编码数据，再往后扫只会误判
    if (marker === 0xda || marker === 0xd9) return null

    const length = buffer.readUInt16BE(offset + 2)

    if (length < 2) return null

    if (SOF_MARKERS.has(marker) && offset + 9 < buffer.length) {
      // FF Cn | 长度(2) | 精度(1) | 高(2) | 宽(2)
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    }

    offset += 2 + length
  }

  return null
}

function readWebp(buffer) {
  if (buffer.length < 30) return null
  if (buffer.subarray(8, 12).toString('latin1') !== 'WEBP') return null

  const chunk = buffer.subarray(12, 16).toString('latin1')

  // VP8X：高位在前的前 24 位各存 (宽-1) / (高-1)
  if (chunk === 'VP8X') {
    const width = buffer.readUIntLE(24, 3) + 1
    const height = buffer.readUIntLE(27, 3) + 1

    return width > 0 && height > 0 ? { width, height } : null
  }

  // VP8L：签名 0x2F 之后的 4 字节里，低 14 位宽-1、次 14 位高-1
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(29)

    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }

  // VP8（有损）：帧头里 0x9D012A 之后是 14 位宽高
  if (chunk === 'VP8 ') {
    if (buffer.length < 40 || buffer.readUIntBE(31, 3) !== 0x9d012a) return null

    return {
      width: buffer.readUInt16LE(34) & 0x3fff,
      height: buffer.readUInt16LE(36) & 0x3fff,
    }
  }

  return null
}
