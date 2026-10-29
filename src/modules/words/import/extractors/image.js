import { ocrFailed } from '../../../../shared/errors.js'
import { parseWordText } from '../../word-import.js'
import { isTooLarge, readImageSize } from '../image-size.js'
import { recognizeImage } from '../ocr.js'

/**
 * 图片抽取（md/48 §7.2 快速模式）。
 *
 * **只认英文，释义一律丢弃**：tesseract 的强项是英文印刷体，中文是弱项，
 * 而行内混排（`abandon 放弃`）恰恰最常见。与其把识别错的中文写进用户的词库，
 * 不如让释义留空——现有规则会在「空释义 + 词库命中」时补上词库快照
 * （md/44 规则 5b），用户拿到的释义反而是准的。
 *
 * 代价：用户自己想记的释义没了。要保留就只能切到 `eng+chi_sim`（md/48 §7.2
 * 完整模式），那是后续阶段的事。
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ rows: Array<{index:number, word:string, meaning:string}>, warnings: Array }>}
 */
export async function extractImage(buffer) {
  const text = await extractImageText(buffer)

  const rows = []
  const warnings = []

  for (const entry of parseWordText(text)) {
    // OCR 常把横向排布的多个词黏成一行（`abandon ability able`），
    // parseWordText 会把它当成一个整词。这里再拆一刀：
    // 没有释义且含空白 → 按空白拆成多个候选词
    if (!entry.meaning && /\s/.test(entry.word)) {
      for (const token of entry.word.split(/\s+/)) {
        if (token) rows.push({ index: rows.length, word: token, meaning: '' })
      }

      continue
    }

    if (entry.word) rows.push({ index: rows.length, word: entry.word, meaning: '' })
  }

  if (rows.length === 0) {
    throw ocrFailed('图片里没识别出单词，换一张清楚点的截图，或直接粘贴文本')
  }

  warnings.push({
    code: 'OCR_LOW_CONFIDENCE',
    message: '图片识别难免有错，导入前请逐条核对',
  })

  // 把 OCR 原文带出去：AI 模式需要它。
  // 本地链路（rows 已经按规则切过）不读这个字段，行为不变
  return { rows, warnings, text }
}

/**
 * 只跑 OCR、不做切分（md/49 §5.1）。
 *
 * 图片转 AI 时必须给**原始文本**：rows 是本地用坏规则切出来的，
 * 拿它去让模型纠错，等于让模型在一份错的数据上改。
 */
export async function extractImageText(buffer) {
  // 必须在 OCR 之前拦：解码超大的图会直接吃掉几个 GB，崩的是整个进程而不是这次请求
  const tooLarge = isTooLarge(readImageSize(buffer))

  if (tooLarge) {
    throw ocrFailed(
      `图片尺寸太大（${tooLarge.width}×${tooLarge.height}），请压缩或裁剪后再传，也可以直接粘贴文本`,
    )
  }

  return recognizeImage(buffer)
}
