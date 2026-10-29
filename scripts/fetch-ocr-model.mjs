#!/usr/bin/env node
/**
 * 下载 tesseract 语言模型到 data/ocr/（md/48 §7）。
 *
 * 仓库里已经带了 eng 的 fast 模型（约 1.9MB），正常情况下**不需要跑这个脚本**。
 * 它解决的是另外两件事：
 *   1. 换了 OCR_LANG（比如以后要上 `eng+chi_sim`），把新模型拉下来
 *   2. 模型文件被误删 / 一个干净环境只 checkout 了代码没带二进制
 *
 * 用法：
 *   npm run fetch:ocr                # 按 OCR_LANG 下载，已存在则跳过
 *   npm run fetch:ocr -- --force     # 强制重下
 *   npm run fetch:ocr -- chi_sim     # 指定语言，可写 ang+chi 用 `+` 分隔
 *
 * 内网 / 国内网络下 CDN 可能不通，用 OCR_MODEL_BASE_URL 指到自己的镜像：
 *   OCR_MODEL_BASE_URL=https://my.mirror/tessdata npm run fetch:ocr
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET_DIR = join(ROOT, 'data', 'ocr')

/**
 * fast 版比标准版小 5 倍、快一倍，准确率略低。
 * 我们只认印刷体英文单词，fast 完全够用，而且 1.9MB 能直接进仓库。
 */
const BASE_URL = (process.env.OCR_MODEL_BASE_URL ?? 'https://tessdata.projectnaptha.com/4.0.0_fast').replace(
  /\/$/,
  '',
)

const args = process.argv.slice(2)
const force = args.includes('--force')
const langsArg = args.find((arg) => arg !== '--force')
const langs = (langsArg ?? process.env.OCR_LANG ?? 'eng')
  .split('+')
  .map((lang) => lang.trim())
  .filter(Boolean)

if (langs.length === 0) {
  console.error('没有可下载的语言：请传参或设置 OCR_LANG')
  process.exit(1)
}

await mkdir(TARGET_DIR, { recursive: true })

for (const lang of langs) {
  const file = join(TARGET_DIR, `${lang}.traineddata.gz`)

  if (existsSync(file) && !force) {
    console.log(`跳过 ${lang}：${file} 已存在（--force 可重下）`)
    continue
  }

  const url = `${BASE_URL}/${lang}.traineddata.gz`
  console.log(`下载 ${url}`)

  const response = await fetch(url)

  if (!response.ok) {
    console.error(`下载失败：HTTP ${response.status}`)
    console.error('如果所在网络访问不了 CDN，用 OCR_MODEL_BASE_URL 指向镜像后重试')
    process.exit(1)
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  // gzip 魔数 1F 8B：CDN 出错时可能返回一个 HTML 错误页，直接写进去会变成「模型损坏」
  if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    console.error(`下载到的不是 gzip 文件（${buffer.length} 字节），已中止`)
    process.exit(1)
  }

  await writeFile(file, buffer)
  console.log(`完成：${file}（${(buffer.length / 1024 / 1024).toFixed(2)}MB）`)
}
