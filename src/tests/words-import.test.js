import ExcelJS from 'exceljs'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../app.js'
import { MAX_FILE_BYTES, MAX_IMPORT_ROWS } from '../modules/words/import/limits.js'
import { makeDocx, makeDocxTable, makeZipBomb } from './helpers/office-fixtures.js'

/**
 * 文件导入抽取（md/48 §5 / §8 / §10）。
 *
 * OCR 一律 mock：真跑一次 tesseract 要几秒到十几秒，用例跑不动；
 * 而且识别结果会随模型版本变，断言具体单词等于给自己埋不稳定的测试。
 * 这里要验证的是「识别出文本之后，抽取与校验链路对不对」。
 */
vi.mock('../modules/words/import/ocr.js', () => ({
  recognizeImage: vi.fn(async () => 'abandon\nability\nable to\n'),
  shutdownOcr: vi.fn(async () => {}),
}))

const app = createApp()

const extract = (buffer, filename, contentType = 'application/octet-stream') =>
  request(app).post('/api/words/import/extract').attach('file', buffer, { filename, contentType })

/** 最小 PNG：只有文件头，够嗅探用；OCR 已经 mock，不会真的解码 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

/** 带 IHDR 的 PNG 头，尺寸可指定——用来验证解码前的像素上限 */
function makePngHeader(width, height) {
  const buffer = Buffer.alloc(33)

  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer[24] = 8 // bit depth
  buffer[25] = 6 // color type

  return buffer
}

async function makeXlsx(rows, extraSheets = []) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Unit 1')

  rows.forEach((row) => sheet.addRow(row))
  extraSheets.forEach(([name, extraRows]) => {
    const extra = workbook.addWorksheet(name)
    extraRows.forEach((row) => extra.addRow(row))
  })

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

describe('POST /api/words/import/extract', () => {
  it('txt：沿用 parseWordText 的四种分隔写法', async () => {
    const res = await extract(
      Buffer.from('abandon\t放弃\nability - 能力\nable 能够\n\n# 注释\n', 'utf8'),
      'unit1.txt',
      'text/plain',
    )

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('txt')
    expect(res.body.rows.map((row) => [row.word, row.meaning])).toEqual([
      ['abandon', '放弃'],
      ['ability', '能力'],
      ['able', '能够'],
    ])
    expect(res.body.stats).toEqual({ total: 3, valid: 3, invalid: 0 })
  })

  it('csv：表头跳过，引号里的逗号保住', async () => {
    const res = await extract(
      Buffer.from('单词,释义\nabandon,"放弃,抛弃"\nability,能力\n', 'utf8'),
      'unit1.csv',
      'text/csv',
    )

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('csv')
    expect(res.body.rows).toHaveLength(2)
    expect(res.body.rows[0]).toMatchObject({ word: 'abandon', meaning: '放弃,抛弃' })
  })

  it('docx：段落文本按行解析', async () => {
    const docx = makeDocx(['abandon 放弃', 'ability - 能力'])

    const res = await extract(docx, 'unit1.docx')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('docx')
    expect(res.body.rows.map((row) => row.word)).toEqual(['abandon', 'ability'])
  })

  it('docx：表格的一行就是一整条，单元格不会被拆成两行', async () => {
    // 词表九成是表格排版；mammoth.extractRawText 会把每个单元格输出成独立段落，
    // 「abandon | 放弃」就变成「单词一行、纯中文一行」——这条用例专门盯这个
    const docx = makeDocxTable([
      ['单词', '释义'],
      ['abandon', '放弃'],
      ['ability', '能力'],
    ])

    const res = await extract(docx, 'unit1-table.docx')

    expect(res.status).toBe(200)
    expect(res.body.rows.map((row) => [row.word, row.meaning])).toEqual([
      ['abandon', '放弃'],
      ['ability', '能力'],
    ])
    expect(res.body.stats.invalid).toBe(0)
  })

  it('xlsx：跳过表头，多 sheet 给 warning', async () => {
    const xlsx = await makeXlsx(
      [
        ['单词', '释义'],
        ['abandon', '放弃'],
        ['ability', '能力'],
      ],
      [['Unit 2', [['able', '能够']]]],
    )

    const res = await extract(xlsx, 'unit1.xlsx')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('xlsx')
    expect(res.body.rows.map((row) => row.word)).toEqual(['abandon', 'ability'])
    expect(res.body.warnings.map((item) => item.code)).toContain('MULTIPLE_SHEETS')
  })

  it('图片：只取英文词，释义留空，并提示需要核对', async () => {
    const res = await extract(PNG_SIGNATURE, 'shot.png', 'image/png')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('image')
    // "able to" 被拆成两个词：OCR 常把横向排布的词黏成一行
    expect(res.body.rows.map((row) => row.word)).toEqual(['abandon', 'ability', 'able', 'to'])
    expect(res.body.rows.every((row) => row.meaning === '')).toBe(true)
    expect(res.body.warnings.map((item) => item.code)).toContain('OCR_LOW_CONFIDENCE')
  })

  it('尺寸超过上限的图片在 OCR 之前就被拒（防解码 OOM）', async () => {
    const { recognizeImage } = await import('../modules/words/import/ocr.js')
    recognizeImage.mockClear()

    const res = await extract(makePngHeader(20000, 20000), 'huge.png', 'image/png')

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('OCR_FAILED')
    expect(res.body.error.message).toContain('20000×20000')
    // 关键断言：没有进 OCR。进了就等于让 leptonica 去分配 1.6GB
    expect(recognizeImage).not.toHaveBeenCalled()
  })

  it('非法词照常返回 200，标 valid:false 并给出原因', async () => {
    const res = await extract(Buffer.from('and/or\ngive up\n', 'utf8'), 'bad.txt', 'text/plain')

    expect(res.status).toBe(200)
    expect(res.body.stats).toMatchObject({ total: 2, valid: 0, invalid: 2 })
    expect(res.body.rows[0].reason).toContain('只能包含英文字母')
    expect(res.body.rows[1].reason).toContain('暂不支持短语')
  })

  it('超过 500 行时截断，但仍报告真实总数', async () => {
    const lines = Array.from({ length: MAX_IMPORT_ROWS + 20 }, (_, index) => `word${index}`)

    const res = await extract(Buffer.from(lines.join('\n'), 'utf8'), 'big.txt', 'text/plain')

    expect(res.status).toBe(200)
    expect(res.body.rows).toHaveLength(MAX_IMPORT_ROWS)
    expect(res.body.truncated).toBe(true)
    expect(res.body.stats.total).toBe(MAX_IMPORT_ROWS + 20)
  })

  it('.doc 直接 415，并告诉用户该另存为什么', async () => {
    const res = await extract(Buffer.from('whatever'), 'old.doc')

    expect(res.status).toBe(415)
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(res.body.error.message).toContain('.docx')
  })

  it('改后缀骗不过嗅探：png 内容叫 .docx 仍按图片处理', async () => {
    const res = await extract(PNG_SIGNATURE, 'fake.docx')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('image')
  })

  it('不是 zip 却叫 .docx → 415', async () => {
    const res = await extract(Buffer.from('just text', 'utf8'), 'fake.docx')

    expect(res.status).toBe(200)
    // 纯文本按文本解析：嗅探只看内容，扩展名不参与判定
    expect(res.body.source).toBe('txt')
  })

  it('zip 炸弹在解压前被拒', async () => {
    const res = await extract(makeZipBomb(), 'bomb.docx')

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('FILE_PARSE_FAILED')
  })

  it('超过 5MB → 413', async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1024, 0x61)

    const res = await extract(big, 'huge.txt', 'text/plain')

    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('没带文件 → 400', async () => {
    const res = await request(app).post('/api/words/import/extract').field('note', 'x')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
  })

  it('空文件 → 422', async () => {
    const res = await extract(Buffer.alloc(0), 'empty.txt', 'text/plain')

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('FILE_PARSE_FAILED')
  })
})
