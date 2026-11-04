import { config } from '../../config/index.js'
import { notFound } from '../../shared/errors.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { canonicalWord, checkWord } from '../../shared/utils/word-form.js'
import { basicWordByWord } from '../basic-words/basic-words.catalog.js'
import { buildSummary, deriveStudyState } from '../words/word.dto.js'
import { buildCreatePayload } from '../words/word-import.js'
import { wordRepository as repo } from '../words/word.repository.js'
import {
  buildStudyCounts,
  withWordBanks,
} from '../words/word.service.js'
import { updateWordsStatus } from '../words/word-status.service.js'
import { wordBankMembershipRepository as membershipRepo } from './word-bank-membership.repository.js'
import {
  WORD_BANK_BANDS,
  getWordBankCatalog,
} from './word-banks.catalog.js'
import {
  addWordsToBankSchema,
  bankStatusSchema,
  resetBankSchema,
  wordBankListSchema,
} from './word-banks.schema.js'

const BANK_KEYS = new Set(Object.keys(WORD_BANK_BANDS))

/** 404：词库 key 不在 high / mid 里 */
export function wordBankNotFound() {
  return notFound('WORD_BANK_NOT_FOUND', '词库不存在')
}

/** 路由层与 service 共用的 bank 校验 */
export function parseBank(raw) {
  if (!BANK_KEYS.has(raw)) throw wordBankNotFound()
  return raw
}

/**
 * 从某个词库导入、且当前仍在个人词库里的词数。
 *
 * 正常应与导入记录数一致；手动删除词会同时清记录，所以不会长期分叉。
 */
async function countInLibrary(userId, bank) {
  const importedRows = await membershipRepo.findWordsByBank(userId, bank)
  if (!importedRows.length) return 0

  return repo.count({
    userId,
    word: { $in: importedRows.map((item) => item.word) },
    // 与 listWords 的“全部”口径一致：不含基础词墓碑
    source: { $ne: 'basic-removed' },
  })
}

/** GET /api/word-banks */
export async function listWordBanks({ userId }) {
  const [highImported, midImported, libraryCount, highInLibrary, midInLibrary] =
    await Promise.all([
      membershipRepo.countByBank(userId, 'high'),
      membershipRepo.countByBank(userId, 'mid'),
      repo.count({ userId, source: { $ne: 'basic-removed' } }),
      countInLibrary(userId, 'high'),
      countInLibrary(userId, 'mid'),
    ])

  const remainingSlots = Math.max(0, config.wordLibraryLimit - libraryCount)
  const catalog = getWordBankCatalog()

  return {
    banks: Object.entries(WORD_BANK_BANDS).map(([key, band]) => ({
      key,
      label: band.label,
      rankMin: band.min,
      rankMax: band.max,
      total: catalog[key].length,
      importedInLibrary: key === 'high' ? highInLibrary : midInLibrary,
      imported: key === 'high' ? highImported : midImported,
      remainingSlots,
    })),
  }
}

/** GET /api/word-banks/:bank/words */
export async function listWordBankWords({ userId, bank, query }) {
  const catalog = getWordBankCatalog()[bank]
  if (!catalog) throw wordBankNotFound()

  const { page, pageSize, q, filter } = parseOrThrow(wordBankListSchema, query)

  // 1. 先按搜索过滤（词形 + 中文释义）
  const keyword = String(q ?? '').trim().toLowerCase()
  let rows = keyword
    ? catalog.filter(
        (item) =>
          item.word.includes(keyword) ||
          item.entry.senses.some((sense) =>
            String(sense.meaning ?? '').toLowerCase().includes(keyword),
          ),
      )
    : catalog

  // 2. 再按“是否从本词库导入”过滤
  let importedSet = null
  if (filter !== 'all') {
    const importedRows = await membershipRepo.findWordsByBank(userId, bank)
    importedSet = new Set(importedRows.map((item) => item.word))
    rows =
      filter === 'imported'
        ? rows.filter((item) => importedSet.has(item.word))
        : rows.filter((item) => !importedSet.has(item.word))
  }

  // 3. 分页
  const total = rows.length
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, lastPage)
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  // 4. 当前页补个人状态与导入标记
  const words = pageRows.map((item) => item.word)
  const docs = words.length
    ? await repo.findByWords(userId, words, 'word status source createdAt')
    : []
  const docByWord = new Map(docs.map((doc) => [doc.word, doc]))

  if (!importedSet) {
    const memberships = words.length
      ? await membershipRepo.findByWords(userId, words)
      : []
    importedSet = new Set(memberships.map((item) => item.word))
  }

  return {
    bank: { key: bank, label: WORD_BANK_BANDS[bank].label, total: catalog.length },
    items: pageRows.map((item) => {
      const doc = docByWord.get(item.word)

      return {
        word: item.word,
        rank: item.rank,
        phonetic: {
          uk: item.entry.phonetic?.uk ?? null,
          us: item.entry.phonetic?.us ?? null,
        },
        senses: item.entry.senses.map((sense) => ({
          pos: sense.pos ?? '',
          meaning: sense.meaning,
        })),
        summary: buildSummary(item.entry.senses),
        dictionaryId: item.entry.id ?? null,
        // 个人词库里有没有这个词（包括用户原本就有的 analysis）
        inLibrary: Boolean(doc),
        wordId: doc?._id ? String(doc._id) : null,
        personalStatus: doc?.status ?? null,
        // 前端展示“新词 / 复习中 / 已掌握 / 不认识”用这个；
        // 被标为 removed 的导入词 status 仍是 new，只看 personalStatus 会误显示
        personalStudyState: doc ? deriveStudyState(doc) : null,
        // 是否“从本词库导入”。analysis 可能是 inLibrary=true / imported=false
        imported: importedSet.has(item.word),
      }
    }),
    page: currentPage,
    pageSize,
    total,
  }
}

/** POST /api/word-banks/:bank/add */
export async function addWordsToBank({
  userId,
  bank,
  body,
  now = new Date(),
}) {
  const catalog = getWordBankCatalog()[bank]
  if (!catalog) throw wordBankNotFound()

  const { words, all, limit, cursor, status } = parseOrThrow(
    addWordsToBankSchema,
    body,
  )

  // 1. 选出本轮候选
  let candidates
  let nextCursor = cursor
  let done = true
  const skipped = []

  if (all) {
    const end = Math.min(cursor + limit, catalog.length)
    candidates = catalog.slice(cursor, end)
    done = end >= catalog.length
  } else {
    const requested = new Set()

    for (const raw of words) {
      const word = canonicalWord(raw)
      if (!word || !checkWord(word).ok) {
        skipped.push({ word, reason: 'INVALID_WORD' })
        continue
      }
      requested.add(word)
    }

    candidates = catalog.filter((item) => requested.has(item.word))
    const found = new Set(candidates.map((item) => item.word))

    // 显式选词时，逐条说明为什么没进候选
    for (const word of requested) {
      if (found.has(word)) continue
      skipped.push({
        word,
        reason: basicWordByWord.has(word) ? 'BASIC_WORD_EXCLUDED' : 'NOT_IN_BANK',
      })
    }

    done = true
  }

  // 2. 查已有个人记录 + 已有导入记录
  const candidateWords = candidates.map((item) => item.word)
  const [existingDocs, importedRows] = await Promise.all([
    candidateWords.length
      ? repo.findByWords(userId, candidateWords, null)
      : Promise.resolve([]),
    membershipRepo.findByBankAndWords(userId, bank, candidateWords),
  ])
  const existingByWord = new Map(existingDocs.map((doc) => [doc.word, doc]))
  const importedSet = new Set(importedRows.map((item) => item.word))

  // 3. 计算词库剩余名额
  const currentCount = await repo.count({
    userId,
    source: { $ne: 'basic-removed' },
  })
  let remainingSlots = Math.max(0, config.wordLibraryLimit - currentCount)

  // 4. 分类
  const creates = []
  const existing = []
  const alreadyImported = []
  let exhausted = false
  let processed = 0

  for (const item of candidates) {
    const doc = existingByWord.get(item.word)

    if (doc) {
      // 关键：已在个人词库的词，绝不补导入标记。
      // analysis 属于这一类：它在个人词库，也在高频目录，但不能被重置删掉。
      if (importedSet.has(item.word)) alreadyImported.push(item)
      else existing.push(item)
      processed += 1
      continue
    }

    if (remainingSlots <= 0) {
      exhausted = true
      break
    }

    creates.push(item)
    remainingSlots -= 1
    processed += 1
  }

  // 整库分批时，cursor 只前进到真正处理过的位置；
  // 名额耗尽时停在该词上，用户腾出名额后可从这里继续。
  if (all) nextCursor = cursor + processed

  // 5. 先写导入记录（intent），再创建 Word（effect）。
  //    顺序不能反：如果先建词、账本写失败，重试时该词已经存在且没有账本，
  //    会被误判成“用户原有词”，永远补不上导入标记。
  const bankEntries = creates.map((item) => ({
    word: item.word,
    bank,
    importedAt: now,
    addedBy: all ? 'bulk' : 'manual',
  }))
  await membershipRepo.upsertMany(userId, bankEntries)

  // 6. 以账本为准，只给“确认已有导入记录”的词建 Word。
  const confirmedRows = creates.length
    ? await membershipRepo.findByBankAndWords(
        userId,
        bank,
        creates.map((item) => item.word),
      )
    : []
  const confirmedSet = new Set(confirmedRows.map((item) => item.word))
  const toCreate = creates.filter((item) => confirmedSet.has(item.word))
  const notConfirmed = creates.length - toCreate.length

  // 7. 建 Word。目录已排除基础词，不需要处理 basic-removed 墓碑。
  const docs = toCreate.map((item) =>
    buildCreatePayload({ userId, word: item.word, status, source: 'dictionary' }),
  )

  let createdDocs = []
  if (docs.length) {
    try {
      createdDocs = await repo.insertMany(docs)
    } catch (err) {
      // 并发下可能撞唯一索引；已写入的部分保留，回查后按实际结果计数
      if (err?.code !== 11000 && !err?.writeErrors) throw err
      createdDocs = await repo.findByWords(
        userId,
        toCreate.map((item) => item.word),
        'word',
      )
    }
  }

  const created = createdDocs.length
  const libraryAfter = currentCount + created
  const remainingAfter = Math.max(0, config.wordLibraryLimit - libraryAfter)

  return {
    bank,
    requested: candidates.length,
    created,
    existing: existing.length,
    alreadyImported: alreadyImported.length,
    failed: notConfirmed + (toCreate.length - created),
    skipped,
    nextCursor,
    done: done && !exhausted,
    limitReached: exhausted,
    remainingSlots: remainingAfter,
    counts: {
      library: libraryAfter,
      imported: await membershipRepo.countByBank(userId, bank),
    },
  }
}

/** POST /api/word-banks/:bank/status/batch */
export async function updateBankWordsStatus({
  userId,
  bank,
  body,
  now = new Date(),
}) {
  if (!getWordBankCatalog()[bank]) throw wordBankNotFound()

  const { words, target, dryRun } = parseOrThrow(bankStatusSchema, body)
  const normalized = [...new Set(words.map((word) => canonicalWord(word)))]

  const memberships = await membershipRepo.findByBankAndWords(
    userId,
    bank,
    normalized,
  )
  const memberSet = new Set(memberships.map((item) => item.word))
  const notInBank = normalized.filter((word) => !memberSet.has(word))

  if (!memberSet.size) {
    return {
      target,
      dryRun,
      requested: 0,
      updated: 0,
      unchanged: 0,
      skipped: [],
      ...(dryRun
        ? { plan: [] }
        : { words: [], studyCounts: await buildStudyCounts(userId, now) }),
      bank,
      notInBank,
    }
  }

  const docs = await repo.findByWords(userId, [...memberSet], 'word')
  const ids = docs.map((doc) => String(doc._id))

  const result = await updateWordsStatus({
    userId,
    body: { ids, target, dryRun },
    now,
  })

  return {
    ...result,
    ...(result.words
      ? { words: await withWordBanks(userId, result.words) }
      : {}),
    bank,
    // 这些词在个人词库，但不是从本词库导入的（例如 analysis），不参与本页批量操作
    notInBank,
  }
}

/** POST /api/word-banks/:bank/reset */
export async function resetWordBank({ userId, bank, body }) {
  if (!getWordBankCatalog()[bank]) throw wordBankNotFound()

  // confirm 必须是 true；false / 缺失都会在 schema 层报 400
  parseOrThrow(resetBankSchema, body)

  const memberships = await membershipRepo.findWordsByBank(userId, bank)
  const words = memberships.map((item) => item.word)

  if (!words.length) {
    return { bank, removedWords: 0, keptWords: 0, removedMemberships: 0 }
  }

  // 同一个词如果还属于别的词库，不能因为重置这个库把 Word 删掉
  const otherMemberships = await membershipRepo.findOtherBanksByWords(
    userId,
    bank,
    words,
  )
  const protectedWords = new Set(otherMemberships.map((item) => item.word))

  const docs = await repo.findByWords(userId, words, 'word')
  const deletableWords = docs
    .filter((doc) => !protectedWords.has(doc.word))
    .map((doc) => doc.word)

  if (deletableWords.length) {
    await repo.deleteManyByWords(userId, deletableWords)
  }

  await membershipRepo.deleteByBank(userId, bank)

  return {
    bank,
    removedWords: deletableWords.length,
    // 仍在个人词库、但不属于本词库的词（理论上只有跨词库重叠时出现）
    keptWords: docs.length - deletableWords.length,
    removedMemberships: memberships.length,
  }
}
