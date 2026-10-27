/**
 * 基础词表构建脚本（S7）
 *
 * ⚠️ 当前 data/basic-words.json 已换成人工筛选的 600 词
 *    （功能词 174 + 高频实词 426，见 md/基础词库_600词候选清单.md），
 *    不再是本脚本 --rank 的直接产物。P2 改造用户化基础词库之前
 *    **不要直接重跑本脚本**，否则 600 词会被覆盖回 ~2578 词。
 *
 * 用途：从 COCA 源数据取词频前 N（默认 3000）且有释义的词条，
 *      过滤掉专有名词、复合词、缩写、释义敏感的词，输出 data/basic-words.json。
 *
 * 产出是**初稿**：脚本做完机械过滤，剩下"看着像普通词但其实不适合当基础词"
 * 的条目由 MANUAL_EXCLUDE 人工维护，保证重建结果可复现（改脚本比手改 json 可靠）。
 *
 * 用法：node scripts/build-basic-words.mjs [--src <md 目录>] [--out <文件>] [--rank 3000]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SRC_CANDIDATES = [
  join(ROOT, '..', 'coca-vocabulary'),
  join(ROOT, 'scripts/vendor/coca-vocabulary'),
]
const DEFAULT_SRC = SRC_CANDIDATES.find((dir) => existsSync(dir)) ?? SRC_CANDIDATES[0]
const DEFAULT_OUT = join(ROOT, 'data/basic-words.json')

const POS_RE = /([a-zA-Z][a-zA-Z.&/\s-]{0,14}?)\["(.*?)"\]/g
const BARE_RE = /\["(.*?)"\]/

/** 释义里出现这些词就不当基础词：阅读材料里用不上，孩子看到也不合适 */
const SENSITIVE = [
  '性交',
  '性行为',
  '性欲',
  '色情',
  '妓',
  '娼',
  '强奸',
  '阴茎',
  '阴道',
  '精液',
  '肛门',
  '阳具',
  '屎',
  '尿',
  '屁',
  '他妈',
  '妈的',
  '该死',
  '见鬼',
  '诅咒',
  '吸毒',
  '毒品',
  '大麻',
  '可卡因',
  '海洛因',
  '鸦片',
  '安非他命',
]

/** 缩写/称谓：写文章时不会当普通词用 */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'pm', 'tv'])

/**
 * 源数据里全大写但其实是普通词的条目。
 * 不列白名单的话，"true" 会因为没有小写词头被当成专有名词误杀。
 */
const PROPER_NOUN_KEEP = new Set(['true'])

/**
 * 人工复核后确认要剔除的条目。
 * 这些词要么是缩写的误判（am 是动词，保留），要么是词库里挂错释义的。
 */
const MANUAL_EXCLUDE = new Set([])

/**
 * 人工补充的虚词。
 * COCA 源是词元表：`a/an` 只收了 `a`，`is/am/are` 只收了 `be`（靠不规则表兜住）。
 * 这些词不在源数据里，无法靠排名捞出来，只能显式补——漏掉 `an` 会让每篇含
 * "an apple" 的文章都判超纲，是最隐蔽的一种失败。
 */
const MANUAL_INCLUDE = ['an', 'mine', 'whom', 'shall', 'onto']

function parseArgs(argv) {
  const args = { src: DEFAULT_SRC, out: DEFAULT_OUT, rank: 3000 }

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--src' && argv[i + 1]) args.src = resolve(argv[++i])
    else if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i])
    else if (argv[i] === '--rank' && argv[i + 1]) args.rank = Number(argv[++i])
  }

  return args
}

/** 只取释义列表：判断"有没有释义"用全部，判断"是否敏感"只看第一条 */
function parseMeanings(line) {
  const meanings = []

  POS_RE.lastIndex = 0
  let match
  while ((match = POS_RE.exec(line)) !== null) {
    meanings.push(...match[2].split('","'))
  }

  if (meanings.length) return meanings

  const bare = line.match(BARE_RE)
  return bare ? bare[1].split('","') : []
}

function parseFile(path) {
  const rows = []
  const blocks = readFileSync(path, 'utf8')
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim())

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim())
    const head = lines[0].match(/^(\d+)\s+(.+?)\s*$/)
    if (!head) continue

    rows.push({
      rank: Number(head[1]),
      headword: head[2].replace(/''/g, "'"),
      meanings: parseMeanings((lines[2] || '').replace(/^-\s*/, '')),
    })
  }

  return rows
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  let files
  try {
    files = readdirSync(args.src)
      .filter((file) => file.endsWith('.md'))
      .sort()
  } catch {
    console.error(`源目录不存在：${args.src}`)
    console.error('获取方式见 data/dictionary/README.md 第 4 节。')
    process.exit(1)
  }

  const rows = files.flatMap((file) => parseFile(join(args.src, file)))

  // 同一词头可能在源数据里重复出现，保留排名最高的那次
  const unique = new Map()
  for (const row of rows) {
    const key = row.headword.toLowerCase()
    const existing = unique.get(key)
    if (!existing || row.rank < existing.rank) unique.set(key, row)
  }

  const inRange = [...unique.values()]
    .filter((row) => row.rank <= args.rank)
    .sort((a, b) => a.rank - b.rank)

  const kept = []
  const dropped = { noSense: [], properNoun: [], shape: [], abbreviation: [], sensitive: [], manual: [] }

  for (const row of inRange) {
    const word = row.headword
    const lower = word.toLowerCase()

    if (!row.meanings.length) {
      dropped.noSense.push(word)
      continue
    }
    // 只允许纯字母和撇号：连字符复合词、带点缩写、带重音的借词一律不要
    if (!/^[A-Za-z]+(?:'[A-Za-z]+)?$/.test(word)) {
      dropped.shape.push(word)
      continue
    }
    if (ABBREVIATIONS.has(lower)) {
      dropped.abbreviation.push(word)
      continue
    }
    // 首字母大写＝专有名词；I 是代词，true 在源里是全大写，都得留下
    if (/^[A-Z]/.test(word) && word !== 'I' && !PROPER_NOUN_KEEP.has(lower)) {
      dropped.properNoun.push(word)
      continue
    }
    // 只看第一条释义：force / age / drug / couple 的敏感义项都是靠后的冷门用法，
    // 按整条释义匹配会把基础词大面积误杀
    if (SENSITIVE.some((keyword) => row.meanings[0].includes(keyword))) {
      dropped.sensitive.push(word)
      continue
    }
    if (MANUAL_EXCLUDE.has(lower)) {
      dropped.manual.push(word)
      continue
    }

    kept.push(lower)
  }

  // 源数据里不存在的虚词靠排名永远捞不到，只能显式补
  const keptSet = new Set(kept)
  const added = MANUAL_INCLUDE.filter((word) => !keptSet.has(word))
  for (const word of added) keptSet.add(word)

  const result = [...keptSet]

  // 按字母序输出：diff 稳定，Set 化之后顺序本来也不影响校验
  result.sort()

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${JSON.stringify(result, null, 0)}\n`)

  console.log(`源目录        ${args.src}`)
  console.log(`前 N 词条     ${inRange.length}（N=${args.rank}）`)
  console.log(`无释义剔除    ${dropped.noSense.length}  ${dropped.noSense.slice(0, 20).join(', ')}`)
  console.log(`形态不符剔除  ${dropped.shape.length}  ${dropped.shape.slice(0, 20).join(', ')}`)
  console.log(`缩写剔除      ${dropped.abbreviation.length}  ${dropped.abbreviation.join(', ')}`)
  console.log(`专有名词剔除  ${dropped.properNoun.length}  ${dropped.properNoun.join(', ')}`)
  console.log(`敏感释义剔除  ${dropped.sensitive.length}  ${dropped.sensitive.join(', ')}`)
  console.log(`人工剔除      ${dropped.manual.length}  ${dropped.manual.join(', ')}`)
  console.log(`人工补充      ${added.length}  ${added.join(', ')}`)
  console.log(`最终基础词    ${result.length}`)
  console.log(`输出文件      ${args.out}`)
}

main()
