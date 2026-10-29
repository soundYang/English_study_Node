import {
  basicWordAlreadyLearned,
  basicWordAlreadyRemoved,
  basicWordNotFound,
  basicWordNotRemoved,
  basicWordReadonly,
  functionWordImmutable,
} from '../../shared/errors.js'
import { canonicalWord } from '../../shared/utils/word-form.js'
import { findEntry } from '../dictionary/dictionary.loader.js'
import { buildSummary } from '../words/word.dto.js'
import { getWordRank } from '../words/word-ranks.js'
import { wordRepository as repo } from '../words/word.repository.js'
import {
  BASIC_WORD_GROUPS,
  BASIC_WORD_STATUS_FILTERS,
  basicWordByWord,
  basicWordCatalog,
} from './basic-words.catalog.js'

/**
 * 基础词页面的读写（md/29）。
 *
 * 三件事必须同时成立，这个模块才成立：
 *   1. 页面上的词表 = 基础词 600 ∪ 日历词 19 ∪ 缩写 32，去重后 650 条；
 *   2. 只有 421 个实词能移除/恢复，其余 229 条只读；
 *   3. 列表里每一行都要带「这个人现在认不认识它」，不能只回静态词表。
 *
 * 分页在内存里做：词表本身是进程级常量（650 条），换成数据库分页反而要
 * 先把静态表灌库。每请求只查一次 Mongo（`$in` 650 个词），拿到个人记录后
 * 在内存里做分组、状态筛选和分页。
 */

/**
 * 词形与搜索词都先做同样的规范化：去首尾空格 + 转小写。
 * 不截断——截断会让超长输入「意外命中」某个 45 字符的词，宁可查不到给 404。
 * 规则本身来自 shared/utils/word-form.js，与添加单词共用一份（md/44 §5.1）。
 */
function normalizeWord(raw) {
  return canonicalWord(raw)
}

/**
 * 词表里查条目；查不到就是 404。
 *
 * 不做词形正则校验：基础词表里本来就只有 `[a-z]+`，
 * 传 `book?` 之类的值自然查不到，给 404 比给 400 更准确
 * （用户不会因为「打错一个字」被要求改格式）。
 */
function loadEntry(raw) {
  const word = normalizeWord(raw)
  const entry = basicWordByWord.get(word)

  if (!entry) throw basicWordNotFound(word || String(raw ?? ''))

  return entry
}

/** 只读判定：功能词先说，再说日历词 / 缩写 */
function assertRemovable(entry) {
  if (entry.isFunctionWord) throw functionWordImmutable(entry.word)

  if (!entry.removable) {
    throw basicWordReadonly(
      entry.word,
      entry.kinds.includes('abbreviation') ? 'abbreviation' : 'calendar',
    )
  }
}

/** 个人词库里这些词的记录：word → { _id, status, source } */
async function loadRecords(userId) {
  const docs = await repo.findByWords(
    userId,
    basicWordCatalog.map((entry) => entry.word),
  )

  return new Map(docs.map((doc) => [doc.word, doc]))
}

/**
 * 把「静态词表条目 + 个人记录」合成列表行。
 *
 * 释义与音标始终取自**词库**，不取个人记录：个人记录可能是手填的空释义，
 * 基础词页要展示的是这个词本来的意思。
 */
function toItem(entry, record) {
  const dictionaryEntry = findEntry(entry.word)
  const senses = (dictionaryEntry?.senses ?? []).map((sense) => ({
    pos: sense.pos ?? '',
    meaning: sense.meaning,
  }))

  // removed 只看 status：用户手填一个 status=new 的同名词，同样会被
  // getPersonalBasicWords 从白名单里扣掉，页面口径必须和生成链路一致。
  const removed = record?.status === 'new'

  return {
    word: entry.word,
    // kinds 是全部归属（may 同时是情态动词和五月），kind 只是首项，给徽标用
    kinds: [...entry.kinds],
    kind: entry.kinds[0],
    isFunctionWord: entry.isFunctionWord,
    removable: entry.removable,
    removed,
    // 个人词库状态：null = 没标记过；new = 标了不认识；learning / mastered = 已收录
    personalStatus: record?.status ?? null,
    // 供前端跳词汇页 / 调 PATCH /api/words/:id；没记录时为 null
    wordId: record ? String(record._id) : null,
    cocaRank: getWordRank(entry.word),
    phonetic: dictionaryEntry
      ? {
          uk: dictionaryEntry.phonetic?.uk ?? null,
          us: dictionaryEntry.phonetic?.us ?? null,
        }
      : null,
    senses,
    summary: buildSummary(senses),
    // 缩写的全称（「由哪几个单词组成」）；基础词与日历词为 null
    expansion: entry.expansion,
    expansionMeaning: entry.expansionMeaning,
    // 日历词的细分类：weekday / month；其余为 null
    calendarType: entry.calendarType,
  }
}

/**
 * 顶部数字卡。全部是**全量**口径，不受 q / group / status 影响。
 *
 * 三个状态数之和恒等于 all：这是页面唯一的自检点，
 * 测试里也按这个不变量断言。
 */
function buildCounts(records) {
  const counts = {
    all: 0,
    basic: 0,
    calendar: 0,
    abbreviation: 0,
    removable: 0,
    functionWord: 0,
    learned: 0,
    removed: 0,
    untouched: 0,
  }

  for (const entry of basicWordCatalog) {
    counts.all += 1
    for (const kind of entry.kinds) counts[kind] += 1
    if (entry.removable) counts.removable += 1
    if (entry.isFunctionWord) counts.functionWord += 1

    const record = records.get(entry.word)
    if (!record) counts.untouched += 1
    else if (record.status === 'new') counts.removed += 1
    else counts.learned += 1
  }

  return counts
}

function matchesQuery(item, q) {
  if (!q) return true

  return [
    item.word,
    item.expansion,
    item.expansionMeaning,
    ...item.senses.map((sense) => sense.meaning),
  ].some((text) => String(text ?? '').toLowerCase().includes(q))
}

function matchesStatus(item, status) {
  switch (status) {
    case 'known':
      return item.personalStatus === 'learning' || item.personalStatus === 'mastered'
    case 'removed':
      return item.removed
    case 'unknown':
      return item.personalStatus === null
    default:
      return true
  }
}

/**
 * GET /api/basic-words、GET /api/public/basic-words
 *
 * `personalized = false` 是游客视图（md/50）：**完全不查 Mongo**，
 * 个人状态一律按「没有记录」处理。650 条词表本身就是静态常量，
 * 没有 userId 参与，也就不存在越权读取别人词库的可能。
 */
export async function listBasicWords({ userId, query, personalized = true }) {
  const q = normalizeWord(query.q)
  const group = BASIC_WORD_GROUPS.includes(query.group) ? query.group : 'all'
  const status = BASIC_WORD_STATUS_FILTERS.includes(query.status) ? query.status : 'all'
  const { page, pageSize } = query

  const records = personalized ? await loadRecords(userId) : new Map()
  const counts = buildCounts(records)

  const items = basicWordCatalog
    // 先按分组裁，再构造行：全量 650 条里通常只需要构造一部分
    .filter((entry) => group === 'all' || entry.kinds.includes(group))
    .map((entry) => toItem(entry, records.get(entry.word)))
    .filter((item) => matchesQuery(item, q) && matchesStatus(item, status))

  const total = items.length
  // 与 /api/words 一致：页码越界收敛到末页，并把收敛后的值返回
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, lastPage)
  const start = (currentPage - 1) * pageSize

  return {
    items: items.slice(start, start + pageSize),
    total,
    page: currentPage,
    pageSize,
    counts,
  }
}

/**
 * DELETE /api/basic-words/:word —— 标记不认识（从个人基础词里移除）。
 *
 * 写一条 `{ status:'new', source:'basic-removed' }` 记录，而不是删数据：
 *   · `getPersonalBasicWords` 的减法项就是 status=new 的词，写完立刻生效；
 *   · 记录里带着词库快照，词汇页看到它时不会只剩一个光秃秃的单词。
 *
 * 已经有记录时**不覆盖**：
 *   · status=new  → 已经是不认识了，重复操作给 409；
 *   · 其它状态    → 那条记录上挂着复习时间与曝光次数，覆盖等于抹掉学习进度。
 */
export async function removeBasicWord({ userId, word }) {
  const entry = loadEntry(word)
  assertRemovable(entry)

  const existing = await repo.findOneByWord(userId, entry.word)

  if (existing) {
    if (existing.status === 'new') throw basicWordAlreadyRemoved(entry.word)
    throw basicWordAlreadyLearned(entry.word, existing.status)
  }

  const dictionaryEntry = findEntry(entry.word)

  let created

  try {
    created = await repo.create({
      userId,
      word: entry.word,
      status: 'new',
      source: 'basic-removed',
      dictionaryId: dictionaryEntry?.id ?? null,
      phonetic: dictionaryEntry
        ? {
            uk: dictionaryEntry.phonetic?.uk ?? null,
            us: dictionaryEntry.phonetic?.us ?? null,
          }
        : null,
      senses: (dictionaryEntry?.senses ?? []).map((sense) => ({
        pos: sense.pos ?? '',
        meaning: sense.meaning,
      })),
      cocaRank: getWordRank(entry.word),
    })
  } catch (err) {
    // 并发下两个请求同时过了上面的存在性检查，靠唯一索引兜底
    if (err?.code === 11000) throw basicWordAlreadyRemoved(entry.word)
    throw err
  }

  return buildMutationResult(userId, entry, created)
}

/**
 * PUT /api/basic-words/:word —— 恢复（从「不认识」改回基础词）。
 *
 * 只认 `source: 'basic-removed'` 的记录。用户自己在词汇页加的词
 * （哪怕状态也是 new）不在这里删——那不是这个页面的东西，
 * 删掉就是替用户丢数据。
 */
export async function restoreBasicWord({ userId, word }) {
  const entry = loadEntry(word)
  assertRemovable(entry)

  const existing = await repo.findOneByWord(userId, entry.word)

  if (!existing) throw basicWordNotRemoved(entry.word)

  if (existing.source !== 'basic-removed' || existing.status !== 'new') {
    throw basicWordAlreadyLearned(entry.word, existing.status)
  }

  await repo.deleteByWord(userId, entry.word)

  return buildMutationResult(userId, entry, null)
}

/** 写操作统一回「这一行 + 最新数字卡」，前端可以直接替换行、刷新卡片 */
async function buildMutationResult(userId, entry, record) {
  const records = await loadRecords(userId)

  return {
    item: toItem(entry, record ? record.toObject() : null),
    counts: buildCounts(records),
  }
}
