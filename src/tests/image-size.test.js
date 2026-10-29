import { describe, expect, it } from 'vitest'

import { isTooLarge, readImageSize } from '../modules/words/import/image-size.js'
import { MAX_IMAGE_PIXELS } from '../modules/words/import/limits.js'

/**
 * 图片尺寸预读（md/48 §15.4）。
 *
 * 这层是「防解码 OOM」的唯一闸门：文件大小 5MB 挡不住一张 20000×20000 的纯白 PNG。
 * 解析全在文件头上做，所以这些用例用的都是**没有任何像素数据**的假图片——
 * 只要头部字节对，就足够验证我们读得对。
 */

function pngHeader(width, height) {
  const buffer = Buffer.alloc(33)

  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)

  return buffer
}

function jpegHeader(width, height) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    // APP0：长度 16，排在 SOF 前面，验证解析器会正确地跳过它
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    // SOF0：长度 17，精度 8，高 2 字节，宽 2 字节
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff]),
    Buffer.alloc(9),
  ])
}

function webpVp8x(width, height) {
  const buffer = Buffer.alloc(30)

  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(22, 4)
  buffer.write('WEBP', 8, 'latin1')
  buffer.write('VP8X', 12, 'latin1')
  buffer.writeUInt32LE(10, 16)
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)

  return buffer
}

describe('readImageSize', () => {
  it('PNG：读 IHDR 的宽高', () => {
    expect(readImageSize(pngHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 })
  })

  it('JPEG：跳过 APP 段，从 SOF0 取高宽', () => {
    expect(readImageSize(jpegHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('WebP：VP8X 的 24 位宽高是「值减一」', () => {
    expect(readImageSize(webpVp8x(1600, 900))).toEqual({ width: 1600, height: 900 })
  })

  it('读不出来就返回 null，交给 OCR 自己报错', () => {
    expect(readImageSize(Buffer.alloc(0))).toBeNull()
    expect(readImageSize(Buffer.from('PK\x03\x04 not an image'))).toBeNull()
    // 没有 IHDR 的「PNG」
    expect(readImageSize(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]))).toBeNull()
  })
})

describe('isTooLarge', () => {
  it('4000 万像素正好放行，多一个像素就拒', () => {
    expect(isTooLarge({ width: 8000, height: MAX_IMAGE_PIXELS / 8000 })).toBeNull()
    expect(isTooLarge({ width: 8000, height: MAX_IMAGE_PIXELS / 8000 + 1 })).not.toBeNull()
  })

  it('像素没超但单边过长也拒（长截图）', () => {
    expect(isTooLarge({ width: 100, height: 31_000 })).not.toBeNull()
  })

  it('读不出尺寸时不拦截', () => {
    expect(isTooLarge(null)).toBeNull()
  })
})
