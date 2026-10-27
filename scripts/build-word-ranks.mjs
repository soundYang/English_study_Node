/**
 * COCA 词频排名表构建脚本（P1）
 *
 * 用途：把 coca-vocabulary 源数据里的真实排名抽出来，输出 data/word-ranks.json，
 *      供「新增单词时写入 Word.cocaRank」与「选池按难度排序」使用。
 *
 * 为什么不从 data/dictionary/*.json 反推：
 *   分片是按首字母切分的，数组顺序只在**同一个字母内**保持词频顺序，
 *   跨字母的绝对排名在切分时就丢了——直接把 a~z 首尾相接编号，
 *   `the` 会被排到一万多名，难度分级会彻底失真。必须回到源数据取原始排名。
 *
 * 产出格式（对象，键为小写词头）：
 *   { "the": 1, "of": 2, "and": 3, ... }
 *   只保留每个词头**最小**的那次排名（源数据里 in 出现在第 6/128/3038/13656 名，
 *   高的那次才是它在语料里的真实频率）。
 *
 * 用法：node scripts/build-word-ranks.mjs [--src <md 目录>] [--out <文件>]
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
const DEFAULT_OUT = join(ROOT, 'data/word-ranks.json')

/** 词条块的首行：`189 abandon`，第一个字段是 COCA 全局排名 */
const HEAD_RE = /^(\d+)\s+(.+?)\s*$/

function parseArgs(argv) {
  const args = { src: DEFAULT_SRC, out: DEFAULT_OUT }

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--src' && argv[i + 1]) args.src = resolve(argv[++i])
    else if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i])
  }

  return args
}

/** 只关心首行；音标和释义对排名没有用，不解析，省掉一半 IO 后的正则开销 */
function parseFile(path) {
  const rows = []

  for (const block of readFileSync(path, 'utf8').split(/\r?\n\r?\n/)) {
    const firstLine = block.split(/\r?\n/, 1)[0]
    const head = firstLine?.match(HEAD_RE)
    if (!head) continue

    // 源数据里的 o''clock、n''t 是抓取时把撇号转义写坏了，还原成单个撇号
    rows.push({
      rank: Number(head[1]),
      headword: head[2].replace(/''/g, "'").toLowerCase(),
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
    console.error('获取步骤见 data/README.md 第 4 节。')
    process.exit(1)
  }

  const rows = files.flatMap((file) => parseFile(join(args.src, file)))

  const ranks = new Map()
  let duplicated = 0
  for (const row of rows) {
    const existing = ranks.get(row.headword)
    if (existing === undefined) {
      ranks.set(row.headword, row.rank)
      continue
    }

    duplicated += 1
    if (row.rank < existing) ranks.set(row.headword, row.rank)
  }

  // 按排名升序输出：文件本身就是一份词频表，diff 和人工核对都顺眼
  const sorted = [...ranks.entries()].sort((a, b) => a[1] - b[1])
  const payload = Object.fromEntries(sorted)

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${JSON.stringify(payload)}\n`)

  const size = Buffer.byteLength(JSON.stringify(payload))
  const lowest = sorted[sorted.length - 1]

  console.log(`源目录        ${args.src}`)
  console.log(`源文件        ${files.length} 个`)
  console.log(`条目总数      ${rows.length}`)
  console.log(`重复丢弃      ${duplicated}`)
  console.log(`最终词头      ${ranks.size}`)
  console.log(`最大排名      ${lowest[1]}（${lowest[0]}）`)
  console.log(`文件体积      ${(size / 1024).toFixed(0)} KB`)
  console.log(`输出文件      ${args.out}`)
}

main()
