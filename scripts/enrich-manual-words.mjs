#!/usr/bin/env node
/**
 * 历史手填词的词库快照回填（md/51）。
 *
 * 2026-10-29 之前，手填了释义的词一律存成 `source='manual'` +
 * `phonetic: null` + `senses: [{ pos: '', meaning }]`：音标、词性、
 * 词库的完整中文义项都没有落库。这个脚本把已有记录补齐。
 *
 * 只动三样：`dictionaryId` / `phonetic` / `senses`。
 *   · 不动 `status` —— 学习进度是用户的，回填不该改状态；
 *   · 不动 `cocaRank` / `createdAt` —— md/44 §5.3 的不变量；
 *   · 不动 `source` —— 用户释义仍可编辑，标签继续是「手填」。
 *
 * 用户释义永远不丢：词库义项覆盖到的视为已包含（词库说法更完整），
 * 覆盖不到的追加到最后一条。例外是解码残留的乱码（既没有汉字也不是纯 ASCII，
 * 如 GBK 被当 UTF-8 读出来的 `ƻ��`）：这类文本已经不可恢复，直接丢弃并在汇总里报数。
 * 幂等：连跑两次结果一致。
 *
 * 用法：
 *   node scripts/enrich-manual-words.mjs --user <userId>          # dry-run，只统计
 *   node scripts/enrich-manual-words.mjs --user <userId> --yes    # 真写
 *   node scripts/enrich-manual-words.mjs --all --yes              # 所有账号（慎用）
 *
 * dry-run 会打印前 5 条的「回填前 / 回填后」，确认没问题再加 `--yes`。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { findEntry, loadDictionary } from '../src/modules/dictionary/dictionary.loader.js'
import { isCoveredByEntry, mergeSenses } from '../src/modules/words/word-import.js'
import { Word } from '../src/modules/words/word.model.js'

const hasFlag = (name) => process.argv.includes(`--${name}`)

function readOption(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const userId = readOption('user')
const all = hasFlag('all')
const write = hasFlag('yes')

if (!all && !userId) {
  console.error(
    '用法：node scripts/enrich-manual-words.mjs --user <userId> [--yes]\n' +
      '      node scripts/enrich-manual-words.mjs --all [--yes]',
  )
  process.exit(1)
}

/**
 * 释义「像人写的」：含汉字，或纯 ASCII（英文笔记）。
 *
 * 早期演示数据里有 GBK 被当 UTF-8 解码的残留（`苹果` → `ƻ��`，码点含 U+FFFD）。
 * 这些文本已经不可恢复，回填时不能当作用户释义追加到词库义项后面。
 * 纯 ASCII 保留，避免误删「give up」这类英文笔记。
 */
const CJK_PATTERN = /[㐀-鿿豈-﫿]/
const ASCII_PATTERN = /^[\x20-\x7e]+$/

function looksLikeMeaning(text) {
  // U+FFFD 是解码失败留下的替换符；正常的释义不会包含它，
  // 哪怕同一串里恰好蒙对了一个汉字（如「�糿」）
  if (text.includes('�')) return false

  return CJK_PATTERN.test(text) || ASCII_PATTERN.test(text)
}

/**
 * 算出这条记录要补的字段；没有可补的就返回 null。
 * 纯函数，dry-run 与真写走同一条判定。
 *
 * @returns {{ update: object|null, dropped: number }}
 */
function planUpdate(doc) {
  if (doc.source !== 'manual') return { update: null, dropped: 0 }

  const entry = findEntry(doc.word)
  if (!entry?.senses?.length) return { update: null, dropped: 0 }

  const meanings = (doc.senses ?? [])
    .map((sense) => String(sense?.meaning ?? '').trim())
    .filter(Boolean)

  // 词库自身会带回的义项不用重复追加
  const extras = []
  let dropped = 0

  for (const meaning of meanings) {
    if (isCoveredByEntry(entry, meaning)) continue

    if (!looksLikeMeaning(meaning)) {
      dropped += 1
      continue
    }

    extras.push(meaning)
  }

  const senses = mergeSenses(entry, '')

  for (const meaning of extras) {
    if (senses.some((item) => String(item.meaning).trim() === meaning)) continue
    senses.push({ pos: '', meaning })
  }

  const update = {
    dictionaryId: entry.id ?? null,
    phonetic: {
      uk: entry.phonetic?.uk ?? null,
      us: entry.phonetic?.us ?? null,
    },
    senses,
  }

  const unchanged =
    doc.dictionaryId === update.dictionaryId &&
    JSON.stringify(doc.phonetic) === JSON.stringify(update.phonetic) &&
    JSON.stringify(doc.senses) === JSON.stringify(update.senses)

  return { update: unchanged ? null : update, dropped: unchanged ? 0 : dropped }
}

const isFixture = (id) => String(id).startsWith('fixture-')

loadDictionary()

await mongoose.connect(config.mongodbUri)

try {
  const filter = all ? { source: 'manual' } : { source: 'manual', userId }
  const cursor = Word.find(filter)
    .select('userId word source dictionaryId phonetic senses')
    .lean()
    .cursor()

  let scanned = 0
  let candidates = 0
  let written = 0
  let dropped = 0
  const samples = []

  for await (const doc of cursor) {
    scanned += 1

    const { update, dropped: droppedHere } = planUpdate(doc)
    if (!update) continue

    candidates += 1
    dropped += droppedHere

    if (samples.length < 5) {
      samples.push({
        word: doc.word,
        user: isFixture(doc.userId) ? 'fixture-…' : doc.userId,
        phonetic: update.phonetic,
        before: doc.senses,
        after: update.senses,
      })
    }

    if (write) {
      // timestamps:false —— 回填不是用户操作，不该改 updatedAt
      await Word.updateOne({ _id: doc._id }, { $set: update }, { timestamps: false })
      written += 1
    }
  }

  console.log(
    `${write ? '已写入' : 'DRY-RUN（加 --yes 才写库）'}\n` +
      `扫描 manual ${scanned} 条，可补全 ${candidates} 条` +
      (write ? `，实际写入 ${written} 条` : '') +
      (dropped ? `；丢弃乱码释义 ${dropped} 条（含替换符或既无汉字也不是英文）` : ''),
  )

  for (const sample of samples) {
    console.log(JSON.stringify(sample))
  }
} finally {
  await mongoose.disconnect()
}
