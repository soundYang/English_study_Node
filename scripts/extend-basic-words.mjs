#!/usr/bin/env node
/**
 * 基础词表追加扩容（方案 §4.2 做法 B）
 *
 * 保留人工筛选的 600 词，按 COCA 排名往后补，直到总数达到 --target（默认 2000）。
 * **不覆盖人工成果**，这是和「直接重跑 build-basic-words.mjs」的本质区别。
 *
 * 筛选规则与 build-basic-words.mjs 共用 `lib/basic-word-rules.mjs`：
 *   形态（纯字母/撇号）· 缩写 · 专名 · 首义项敏感 · 有释义
 * 排名来自 data/word-ranks.json；原始大小写与释义来自 data/dictionary/*.json
 * （排名表全部小写，只有词库还留着 "John" 这种首字母大写的线索）。
 *
 * 用法：
 *   node scripts/extend-basic-words.mjs --dry-run            # 只看会补哪些词
 *   node scripts/extend-basic-words.mjs                      # 补满 rank ≤ 3000，写回
 *   node scripts/extend-basic-words.mjs --max-rank 2500      # 覆盖到更低的词频
 *   node scripts/extend-basic-words.mjs --target 2000        # 硬性限制词数
 *   node scripts/extend-basic-words.mjs --out /tmp/next.json # 先落临时文件做 diff
 *
 * 产物是**完整词表**（600 + 新增），按字母序输出——和原文件同格式，diff 稳定。
 * 写回后 `basicWordsVersion` 必然变化，跨版本的采样不能放在一起比（§3.3）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ABBREVIATIONS,
  PROPER_NOUN_KEEP,
  SHAPE_RE,
  isSensitiveMeaning,
} from './lib/basic-word-rules.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASIC_FILE = join(ROOT, 'data/basic-words.json')
const RANKS_FILE = join(ROOT, 'data/word-ranks.json')

/**
 * 默认按「判定线」补：`missing_common` 的定义就是 rank ≤ 3000 且不在放行表里
 * （§3.2.2，`COMMON_WORD_RANK`），所以放行表覆盖到 3000 才算真正对齐——
 * 补到 2000 个词只走到 rank 2302，中间那段 breakfast(2402)/rapidly(2550) 还会误判。
 * `--target` 只是安全阀，防止哪天源数据变了把词表撑爆。
 */
const DEFAULTS = { target: null, maxRank: 3000, preview: 30, out: BASIC_FILE }

function parseArgs(argv) {
  const args = { ...DEFAULTS, dryRun: false }

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true
    else if (argv[i] === '--target' && argv[i + 1]) args.target = Number(argv[++i])
    else if (argv[i] === '--max-rank' && argv[i + 1]) args.maxRank = Number(argv[++i])
    else if (argv[i] === '--preview' && argv[i + 1]) args.preview = Number(argv[++i])
    else if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i])
  }

  if (args.target !== null && (!Number.isInteger(args.target) || args.target <= 0)) {
    throw new Error('--target 必须是正整数')
  }
  if (!Number.isInteger(args.maxRank) || args.maxRank <= 0) throw new Error('--max-rank 必须是正整数')

  return args
}

/**
 * 一个候选词能不能进基础词表。
 * 返回 null 表示通过，否则返回剔除原因（用于统计，不改判定）。
 */
function rejectReason(word, entry) {
  if (!entry) return 'noEntry'
  // 形态按词库里的原始写法判：带连字符、缩写点、重音符号的都不收
  if (!SHAPE_RE.test(entry.headword)) return 'shape'
  if (ABBREVIATIONS.has(word)) return 'abbreviation'
  // 首字母大写＝专名；I 是代词，true 在源里是全大写，两个都留
  if (/^[A-Z]/.test(entry.headword) && entry.headword !== 'I' && !PROPER_NOUN_KEEP.has(word)) {
    return 'properNoun'
  }
  if (!entry.senses?.length) return 'noSense'
  // 只判第一条义项：靠后的冷门义项不该把常用词误杀（见 basic-word-rules.js）
  if (isSensitiveMeaning(entry.senses[0].meaning)) return 'sensitive'

  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const current = JSON.parse(readFileSync(BASIC_FILE, 'utf8'))
  const ranks = JSON.parse(readFileSync(RANKS_FILE, 'utf8'))

  // 词库加载会做一次和线上一致的 isSavable 过滤，拿到的 entry 才带原始大小写与释义
  const { loadDictionary, dictionary } = await import(
    '../src/modules/dictionary/dictionary.loader.js'
  )
  loadDictionary()

  const keep = new Set(current)
  const before = keep.size
  const added = []
  const dropped = {}
  const droppedWords = {}

  const ranked = Object.entries(ranks).sort((a, b) => a[1] - b[1])

  for (const [rankedWord, rank] of ranked) {
    if (args.target !== null && keep.size >= args.target) break
    if (rank > args.maxRank) break

    const word = rankedWord.toLowerCase()
    if (keep.has(word)) continue

    const reason = rejectReason(word, dictionary.get(word))
    if (reason) {
      dropped[reason] = (dropped[reason] ?? 0) + 1
      ;(droppedWords[reason] ??= []).push(word)
      continue
    }

    keep.add(word)
    added.push({ word, rank })
  }

  const result = [...keep].sort()

  console.log(`当前词表      ${before}`)
  console.log(
    `补词范围      rank ≤ ${args.maxRank}` +
      (args.target === null ? '（补满）' : `，上限 ${args.target} 个`),
  )
  console.log(`新增          ${added.length}`)
  console.log(
    added.length
      ? `新增排名区间  ${added[0].rank} – ${added[added.length - 1].rank}`
      : '',
  )
  for (const [reason, count] of Object.entries(dropped)) {
    console.log(`剔除 ${reason.padEnd(12)} ${count}  ${droppedWords[reason].slice(0, 15).join(', ')}`)
  }
  console.log(`最终词数      ${result.length}`)

  console.log(`\n新增词预览（前 ${args.preview} 个，含首义项）`)
  for (const { word, rank } of added.slice(0, args.preview)) {
    const meaning = dictionary.get(word)?.senses?.[0]?.meaning ?? ''
    console.log(`  ${String(rank).padStart(5)}  ${word.padEnd(16)} ${meaning.slice(0, 34)}`)
  }

  if (args.target !== null && result.length < args.target) {
    console.warn(
      `\n⚠️ 只补到 ${result.length} 个：排名上限 ${args.maxRank} 内的可用词已经走完，` +
        '需要更高的 --max-rank 或更低的 --target。',
    )
  }

  if (args.dryRun) {
    console.log('\n[dry-run] 未写入文件。')
    return
  }

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${JSON.stringify(result, null, 0)}\n`)
  console.log(`\n已写入 ${args.out}（basicWordsVersion 会随之变化）`)
}

main().catch((error) => {
  console.error('[extend-basic-words] 失败：', error.message)
  process.exitCode = 1
})
