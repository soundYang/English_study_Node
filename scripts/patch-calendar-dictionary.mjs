#!/usr/bin/env node
/**
 * 给 COCA 词库补上日历词（星期 + 月份）。
 *
 * COCA 词元表把专有名词整类剔除了，`calendar-words.js` 白名单里的 19 个词
 * 有 17 个在 `data/dictionary` 里一条都没有，`march` 也缺「三月」义项。
 * 基础词页的音标 / 词性 / 释义全部取自词库（basic-words.service.js 的 `toItem`），
 * 缺条目 = 卡片上只有一个单词；`/api/dictionary/search?q=monday` 也搜不到。
 *
 * 为什么单独一个脚本而不是改 build-dictionary.mjs：上游数据里就是没有这些词，
 * 重跑构建会把补录冲掉，补完再跑一次本脚本即可（幂等）。
 *
 * 条目追加在分片末尾：文件顺序是 COCA 词频顺序，人工补的词没有排名，
 * 排最后比编一个假排名诚实；精确查询不受影响（完全匹配本来就排最前）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { calendarWords } from '../src/modules/readings/calendar-words.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data', 'dictionary')
const META_PATH = join(DATA_DIR, 'meta.json')
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/** 与 dictionary.loader.js 的 isSavable 同口径，meta 的计数要能对上启动日志 */
const WORD_PATTERN = /^[a-z'-]+$/
const MAX_HEADWORD_LENGTH = 45

/**
 * 词头保留专有名词大小写（与现有的 `English` 一致），检索仍不区分大小写。
 * 顺序：星期 → 月份，与 calendar-words.js 保持一致。
 */
const ENTRIES = [
  ['Monday', '/ˈmʌndeɪ/', '/ˈmʌndeɪ/', [['n.', '星期一']]],
  ['Tuesday', '/ˈtju:zdeɪ/', '/ˈtu:zdeɪ/', [['n.', '星期二']]],
  ['Wednesday', '/ˈwenzdeɪ/', '/ˈwenzdeɪ/', [['n.', '星期三']]],
  ['Thursday', '/ˈθɜ:zdeɪ/', '/ˈθɜ:rzdeɪ/', [['n.', '星期四']]],
  ['Friday', '/ˈfraɪdeɪ/', '/ˈfraɪdeɪ/', [['n.', '星期五']]],
  ['Saturday', '/ˈsætədeɪ/', '/ˈsætərdeɪ/', [['n.', '星期六']]],
  ['Sunday', '/ˈsʌndeɪ/', '/ˈsʌndeɪ/', [['n.', '星期日，星期天']]],
  ['January', '/ˈdʒænjuəri/', '/ˈdʒænjueri/', [['n.', '一月']]],
  ['February', '/ˈfebruəri/', '/ˈfebrueri/', [['n.', '二月']]],
  ['March', null, null, [['n.', '三月']]], // 已有词条，只补义项
  ['April', '/ˈeɪprəl/', '/ˈeɪprəl/', [['n.', '四月']]],
  ['June', '/dʒu:n/', '/dʒu:n/', [['n.', '六月']]],
  ['July', '/dʒuˈlaɪ/', '/dʒʊˈlaɪ/', [['n.', '七月']]],
  ['August', '/ˈɔ:gəst/', '/ˈɔ:gəst/', [['n.', '八月']]],
  ['September', '/sepˈtembə(r)/', '/sepˈtembər/', [['n.', '九月']]],
  ['October', '/ɒkˈtəʊbə(r)/', '/ɑ:kˈtoʊbər/', [['n.', '十月']]],
  ['November', '/nəʊˈvembə(r)/', '/noʊˈvembər/', [['n.', '十一月']]],
  ['December', '/dɪˈsembə(r)/', '/dɪˈsembər/', [['n.', '十二月']]],
  // May 已有「五月」义项，不需要补
]

function isSavable(word, senses) {
  if (!Array.isArray(senses) || senses.length === 0) return false
  if (word.length > MAX_HEADWORD_LENGTH) return false

  return WORD_PATTERN.test(word)
}

function readShard(letter) {
  return JSON.parse(readFileSync(join(DATA_DIR, `${letter}.json`), 'utf8'))
}

function writeShard(letter, rows) {
  writeFileSync(join(DATA_DIR, `${letter}.json`), JSON.stringify(rows))
}

/** 本次实际改动：新增词条 N 条、补义项 M 条 */
const added = []
const merged = []

for (const [headword, uk, us, senses] of ENTRIES) {
  const letter = headword[0].toLowerCase()
  const rows = readShard(letter)
  const key = headword.toLowerCase()
  const index = rows.findIndex((row) => String(row[0]).toLowerCase() === key)

  if (index === -1) {
    if (uk === null || us === null) {
      throw new Error(`${headword} 词库中没有，但脚本没给音标`)
    }

    rows.push([headword, uk, us, senses])
    writeShard(letter, rows)
    added.push(headword)
    continue
  }

  // 已有词条：补义项并把它排在最前。
  // 卡片 summary 只取前两条义项（buildSummary），排在最后等于不显示——
  // march 原本是「行进、行军」，不前置的话日历词卡片上根本看不到「三月」。
  const existing = rows[index][3]
  const next = [...senses, ...existing].filter(
    ([, meaning], position, list) =>
      list.findIndex(([, other]) => other === meaning) === position,
  )

  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    rows[index][3] = next
    writeShard(letter, rows)
    merged.push(`${headword}(${senses.map(([, meaning]) => meaning).join('、')})`)
  }
}

// meta 的两个计数直接从分片重算，避免手改数字时漏掉
let rawTotal = 0
let searchable = 0

for (const letter of LETTERS) {
  for (const [headword, , , senses] of readShard(letter)) {
    rawTotal += 1
    if (isSavable(String(headword).toLowerCase(), senses)) searchable += 1
  }
}

const meta = JSON.parse(readFileSync(META_PATH, 'utf8'))
const changed = added.length > 0 || merged.length > 0
const countsStale = meta.totalWords !== rawTotal || meta.searchableWords !== searchable

if (changed || countsStale) {
  meta.totalWords = rawTotal
  meta.searchableWords = searchable
  meta.patchedAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00')
  meta.patchNote = 'generatedAt 是建库时的占位时间（不是真实抓取时刻）；an / mine / onto / shall / whom / yourselves 等条目由 a5d675b 人工补录，晚于它。'
    + '19 个日历词（星期 / 月份）与 march 的「三月」义项由 scripts/patch-calendar-dictionary.mjs 补录，'
    + '重跑 build-dictionary.mjs 会冲掉，补完要再跑一次该脚本。totalWords / searchableWords 由脚本按分片重算，与当前分片一致'

  writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`)
}

console.log(`新增 ${added.length} 条：${added.join(', ') || '（无）'}`)
console.log(`补义项 ${merged.length} 条：${merged.join(', ') || '（无）'}`)
console.log(`词库合计 rawTotal=${rawTotal} searchable=${searchable}`)

/**
 * may 已经有「五月」义项（`[May]五月；山楂属植物…`），不需要补；
 * 其余日历词必须都在表里，否则新加的日历词又会掉回「只有一个单词」的状态。
 */
const ALREADY_PRESENT = new Set(['may'])
const covered = new Set([...ENTRIES.map(([headword]) => headword.toLowerCase()), ...ALREADY_PRESENT])
const uncovered = calendarWords.filter((word) => !covered.has(word))

if (uncovered.length > 0) {
  console.log(`注意：calendar-words.js 里还有 ${uncovered.length} 个词不在本脚本表内：${uncovered.join(', ')}`)
}
