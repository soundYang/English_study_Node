/**
 * COCA 词库构建脚本
 *
 * 用途：把 coca-vocabulary-20000 仓库的 101 个 vocabulary/*.md 解析成前端可用的
 *      按首字母分片的 JSON，输出到 src/assets/dictionary/。
 * 用法：node scripts/build-dictionary.mjs [--src <md 目录>] [--out <输出目录>]
 *
 * 源数据格式（每个词条 4 行，条目之间空行）：
 *   20001 abandon
 *   - [əˈbændən]  [əˈbændən]
 *   - v.["放弃","抛弃"]  n.["放任"]
 *   - [人人词典](...) [柯林斯](...) [朗文](...)
 *
 * 产出格式（紧凑数组，为体积考虑不做对象化）：
 *   [[headword, uk, us, [[pos, meaning], ...]], ...]
 *   数组顺序即 COCA 词频顺序，索引越小越高频，搜索排序直接依赖它。
 *
 * 数据处理规则见 README.md，或直接读下方 normalize 相关注释。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 源目录默认优先找与仓库同级的 coca-vocabulary（见 README 第 4 节），
// 其次兼容早期放在 scripts/vendor/coca-vocabulary 的旧布局
const SRC_CANDIDATES = [
  join(ROOT, '..', 'coca-vocabulary'),
  join(ROOT, 'scripts/vendor/coca-vocabulary'),
]
const DEFAULT_SRC = SRC_CANDIDATES.find((dir) => existsSync(dir)) ?? SRC_CANDIDATES[0]
const DEFAULT_OUT = join(ROOT, 'data/dictionary')

/** 匹配 `pos.["义项","义项"]`，词性最多 15 字符以容纳 `vt.& vi.` 这类写法 */
const POS_RE = /([a-zA-Z][a-zA-Z.&/\s-]{0,14}?)\["(.*?)"\]/g

/** 匹配没有词性前缀的裸释义 `["义项","义项"]`，仅用于兜底 */
const BARE_RE = /\["(.*?)"\]/

/** 解析命令行参数，只支持 --src / --out 两个可选项 */
function parseArgs(argv) {
  const args = { src: DEFAULT_SRC, out: DEFAULT_OUT }

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--src' && argv[i + 1]) args.src = resolve(argv[++i])
    else if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i])
  }

  return args
}

/**
 * 把一行释义文本解析成 sense 数组。
 * 优先按「词性 + 义项数组」解析；解析不出时退回裸数组，词性留空串，
 * 因为源数据里有约 160 条只有义项没有词性（如 should），丢掉可惜。
 */
function parseSenses(line) {
  const senses = []

  POS_RE.lastIndex = 0
  let match
  while ((match = POS_RE.exec(line)) !== null) {
    const meanings = match[2]
      .split('","')
      .map((item) => item.trim())
      .filter(Boolean)
    if (!meanings.length) continue
    senses.push([match[1].trim().replace(/\s+/g, ' '), meanings.join('；')])
  }
  if (senses.length) return senses

  const bare = line.match(BARE_RE)
  if (!bare) return senses

  const meanings = bare[1]
    .split('","')
    .map((item) => item.trim())
    .filter(Boolean)
  if (meanings.length) senses.push(['', meanings.join('；')])

  return senses
}

/** 解析单个 md 文件，返回词条数组 */
function parseFile(path) {
  const rows = []
  const text = readFileSync(path, 'utf8')
  const blocks = text.split(/\r?\n\r?\n/).filter((block) => block.trim())

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim())
    const head = lines[0].match(/^(\d+)\s+(.+?)\s*$/)
    if (!head) continue

    const phonetic = (lines[1] || '').match(/^-\s*\[([^\]]*)\]\s*\[([^\]]*)\]/)
    // 源数据里的 o''clock、n''t 是抓取时把撇号转义写坏了，还原成单个撇号
    const headword = head[2].replace(/''/g, "'")

    rows.push({
      rank: Number(head[1]),
      headword,
      uk: phonetic ? phonetic[1].trim() : '',
      us: phonetic ? phonetic[2].trim() : '',
      senses: parseSenses((lines[2] || '').replace(/^-\s*/, '')),
    })
  }

  return rows
}

/** 音标统一包成 /.../，空音标返回 null 交给 UI 显示占位符 */
function toPhonetic(value) {
  return value ? `/${value}/` : null
}

/** 按首字母归组，非字母开头的词归到 # 片 */
function shardKey(headword) {
  const first = headword[0].toLowerCase()
  return /[a-z]/.test(first) ? first : '#'
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
    console.error(
      `请把词表放在 ${SRC_CANDIDATES[0]}，获取步骤见 src/assets/dictionary/README.md 第 4 节。`,
    )
    process.exit(1)
  }

  const rows = files.flatMap((file) => parseFile(join(args.src, file)))

  // 源列表存在同一单词在不同排名重复出现的情况（如 in 出现 4 次），
  // 其释义完全一致，按词头小写去重并保留最小排名（最高频的那次）
  const unique = new Map()
  let duplicated = 0
  for (const row of rows) {
    const key = row.headword.toLowerCase()
    const existing = unique.get(key)
    if (!existing) unique.set(key, row)
    else {
      duplicated += 1
      if (row.rank < existing.rank) unique.set(key, row)
    }
  }

  const entries = [...unique.values()].sort((a, b) => a.rank - b.rank)
  const groups = new Map()
  for (const entry of entries) {
    const key = shardKey(entry.headword)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push([entry.headword, toPhonetic(entry.uk), toPhonetic(entry.us), entry.senses])
  }

  // 只清理旧的 json 分片，保留目录里的 README.md，避免重建时把数据来源说明一起删掉
  mkdirSync(args.out, { recursive: true })
  for (const file of readdirSync(args.out)) {
    if (file.endsWith('.json')) rmSync(join(args.out, file), { force: true })
  }

  let rawTotal = 0
  let gzipTotal = 0
  const report = []
  for (const key of [...groups.keys()].sort()) {
    const payload = JSON.stringify(groups.get(key))
    writeFileSync(join(args.out, `${key}.json`), payload)
    const raw = Buffer.byteLength(payload)
    const gz = gzipSync(payload).length
    rawTotal += raw
    gzipTotal += gz
    report.push({ key, count: groups.get(key).length, raw, gz })
  }

  report.sort((a, b) => b.raw - a.raw)
  console.log(`源文件        ${files.length} 个`)
  console.log(`条目总数      ${rows.length}`)
  console.log(`去重丢弃      ${duplicated}`)
  console.log(`最终词数      ${entries.length}`)
  console.log(`缺音标        ${entries.filter((item) => !item.uk && !item.us).length}`)
  console.log(`无释义        ${entries.filter((item) => !item.senses.length).length}`)
  console.log(`分片数        ${report.length}`)
  console.log(
    `总体积        ${(rawTotal / 1024 / 1024).toFixed(2)} MB（gzip ${(gzipTotal / 1024 / 1024).toFixed(2)} MB）`,
  )
  console.log('最大的 6 片:')
  for (const item of report.slice(0, 6)) {
    console.log(
      `  ${item.key}  ${String(item.count).padStart(5)} 词   raw ${(item.raw / 1024).toFixed(0)}KB   gz ${(item.gz / 1024).toFixed(0)}KB`,
    )
  }
  console.log(`输出目录      ${args.out}`)
}

main()
