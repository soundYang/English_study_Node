/**
 * 测试用的最小 Office 文件构造器（md/48 §10）。
 *
 * 为什么不在仓库里放二进制夹具：
 *   · docx / xlsx 是 zip，git 里 diff 不了，坏了也看不出哪里坏
 *   · 用代码生成，测试用例想验证什么就造什么（比如把表头写成不同写法）
 *
 * 只实现了 STORE（不压缩）这一种方式——mammoth / exceljs 都能读，
 * 而我们要验证的是「抽取逻辑」，不是压缩算法。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }

  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff

  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

/** DOS 时间：固定成一个常量，保证同样输入得到同样字节 */
const DOS_TIME = 0
const DOS_DATE = 0x21 // 1980-01-01

/**
 * @param {Array<{ name: string, content: string|Buffer, declaredUncompressed?: number }>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8')
    const crc = crc32(data)
    const declared = entry.declaredUncompressed ?? data.length

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method = store
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size
    local.writeUInt32LE(declared, 22) // uncompressed size（可被覆盖成炸弹）
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10) // method = store
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(declared, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuffer, eocd])
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

/**
 * 造一个能被 mammoth 读出来的最小 docx。
 *
 * @param {string[]} paragraphs 每个元素是一个段落
 * @returns {Buffer}
 */
export function makeDocx(paragraphs) {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join('')

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`

  return createZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'word/document.xml', content: document },
  ])
}

/**
 * 造一个「表格排版」的最小 docx —— 词表最常见的形态。
 *
 * @param {string[][]} rows 每个元素是一行，元素里的字符串是各单元格
 * @returns {Buffer}
 */
export function makeDocxTable(rows) {
  const table = rows
    .map(
      (cells) =>
        `<w:tr>${cells
          .map((text) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p></w:tc>`)
          .join('')}</w:tr>`,
    )
    .join('')

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:tbl>${table}</w:tbl></w:body></w:document>`

  return createZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'word/document.xml', content: document },
  ])
}

/**
 * 造一个「声明解压后很大」的 zip，用来验证 zip 炸弹防护。
 * 解压后真实的字节只有几十个，防护必须只看中央目录里的声明值。
 *
 * @param {number} declaredBytes 声明解压后的大小
 * @returns {Buffer}
 */
export function makeZipBomb(declaredBytes = 200 * 1024 * 1024) {
  return createZip([
    { name: 'word/document.xml', content: '<w:document/>', declaredUncompressed: declaredBytes },
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
  ])
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
