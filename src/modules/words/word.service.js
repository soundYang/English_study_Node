import mongoose from 'mongoose'

import {
  ApiError,
  ERROR_CODES,
  badRequest,
  conflict,
  wordNotFound,
} from '../../shared/errors.js'
import { escapeRegex } from '../../shared/utils/regex.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { findEntry } from '../dictionary/dictionary.loader.js'
import { toWordDto } from './word.dto.js'
import { wordRepository as repo } from './word.repository.js'
import {
  WORD_STATUSES,
  WORD_STATUS_FILTERS,
  createWordSchema,
  updateWordSchema,
} from './word.schema.js'

const WORD_MAX_LENGTH = 45
const WORD_PATTERN = /^[a-z'-]+$/
/** 手填释义上限；词库义项不受这个限制（apt 有 163 字） */
const MANUAL_MEANING_MAX_LENGTH = 100
/** PATCH 时不允许修改的字段 */
const READONLY_FIELDS = ['source', 'dictionaryId', 'phonetic', 'senses']

/** 去首尾空格 + 转小写，再按词形规则校验 */
function normalizeWord(raw) {
  const word = String(raw).trim().toLowerCase()

  if (
    word.length === 0 ||
    word.length > WORD_MAX_LENGTH ||
    !WORD_PATTERN.test(word)
  ) {
    throw badRequest(
      '单词只能包含英文字母、连字符和撇号，且不超过 45 个字符',
      'word',
    )
  }

  return word
}

function normalizeMeaning(raw) {
  const meaning = String(raw ?? '').trim()

  if (meaning.length > MANUAL_MEANING_MAX_LENGTH) {
    throw badRequest(
      `释义不能超过 ${MANUAL_MEANING_MAX_LENGTH} 个字符`,
      'meaning',
    )
  }

  return meaning
}

/**
 * GET /api/words
 *
 * 三个口径必须同时满足：
 *   counts —— 全量，不带任何筛选
 *   total  —— 带 q 和 status 筛选
 *   page   —— 越界收敛到最后一页，并把收敛后的值返回
 */
export async function listWords({ userId, query }) {
  const { q, page, pageSize } = query
  // status 传了未知值就按「不筛选」处理：契约里没定义这个 400
  const status = WORD_STATUS_FILTERS.includes(query.status)
    ? query.status
    : 'all'

  const filter = { userId }
  if (status !== 'all') filter.status = status

  // 空串表示不搜索，不能当成「匹配空字符串」去扫全表
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i')
    filter.$or = [{ word: pattern }, { 'senses.meaning': pattern }]
  }

  const total = await repo.count(filter)
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, lastPage)

  const items =
    total === 0
      ? []
      : await repo.findPage({
          filter,
          skip: (currentPage - 1) * pageSize,
          limit: pageSize,
        })

  const rows = await repo.countByStatus(userId)
  const counts = { all: 0, mastered: 0, learning: 0, new: 0 }
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.n
    counts.all += row.n
  }

  return {
    items: items.map(toWordDto),
    total,
    page: currentPage,
    pageSize,
    counts,
  }
}

/** POST /api/words */
export async function createWord({ userId, body }) {
  const parsed = parseOrThrow(createWordSchema, body)
  const word = normalizeWord(parsed.word)

  // source 只认 dictionary，其它一律按 manual
  const source = parsed.source === 'dictionary' ? 'dictionary' : 'manual'
  // status 非法回落 learning，不报错（契约 §3.2 第 7 条）
  const status = WORD_STATUSES.includes(parsed.status)
    ? parsed.status
    : 'learning'

  let payload

  if (source === 'dictionary') {
    // 以服务端词库为准：忽略请求体里的 phonetic / senses
    const entry = findEntry(word)
    if (!entry || !entry.senses?.length) {
      throw new ApiError(
        400,
        ERROR_CODES.DICTIONARY_ENTRY_NOT_FOUND,
        '词库中没有这个单词',
      )
    }

    payload = {
      userId,
      word,
      status,
      source,
      dictionaryId: entry.id ?? null,
      phonetic: {
        uk: entry.phonetic?.uk ?? null,
        us: entry.phonetic?.us ?? null,
      },
      senses: entry.senses.map((sense) => ({
        pos: sense.pos ?? '',
        meaning: sense.meaning,
      })),
    }
  } else {
    const meaning = normalizeMeaning(parsed.meaning)

    payload = {
      userId,
      word,
      status,
      source: 'manual',
      dictionaryId: null,
      phonetic: null,
      senses: meaning ? [{ pos: '', meaning }] : [],
    }
  }

  if (await repo.existsByWord(userId, word)) {
    throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
  }

  try {
    return toWordDto(await repo.create(payload))
  } catch (err) {
    // 并发下两个请求同时过了上面的 exists 检查，靠唯一索引兜底
    if (err?.code === 11000) {
      throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
    }
    throw err
  }
}

/**
 * PATCH /api/words/:id
 *
 * 校验顺序不可调整：404 → 400 只读字段 → 400 格式 → 409 重复。
 * 反过来会出现「改一个不存在的 id，却先报字段只读」这种误导性错误。
 */
export async function updateWord({ userId, id, body }) {
  if (!mongoose.isValidObjectId(id)) throw wordNotFound()

  const doc = await repo.findByIdAndUser(id, userId)
  if (!doc) throw wordNotFound()

  // 只读字段必须在 zod 解析之前查：zod 会把未知键剥掉
  for (const field of READONLY_FIELDS) {
    if (field in body) {
      throw new ApiError(
        400,
        ERROR_CODES.READONLY_FIELD,
        `${field} 不允许修改`,
        field,
      )
    }
  }

  if (doc.source === 'dictionary' && 'meaning' in body) {
    throw new ApiError(
      400,
      ERROR_CODES.READONLY_FIELD,
      '词库词的释义不允许修改',
      'meaning',
    )
  }

  const parsed = parseOrThrow(updateWordSchema, body)

  if (parsed.status !== undefined && !WORD_STATUSES.includes(parsed.status)) {
    throw badRequest('状态只能是 new / learning / mastered', 'status')
  }

  const nextWord =
    parsed.word !== undefined ? normalizeWord(parsed.word) : doc.word
  const nextMeaning =
    parsed.meaning !== undefined ? normalizeMeaning(parsed.meaning) : undefined

  if (parsed.status !== undefined) doc.status = parsed.status

  const wordChanged = nextWord !== doc.word

  if (wordChanged) {
    if (await repo.existsByWord(userId, nextWord, doc._id)) {
      throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
    }

    const currentMeaning = doc.senses?.[0]?.meaning ?? ''
    doc.word = nextWord

    if (doc.source === 'dictionary') {
      // 改词即降级：快照来自旧词条，继续留着就是在撒谎
      doc.source = 'manual'
      doc.dictionaryId = null
      doc.phonetic = null
      doc.senses = []
    } else {
      const meaning = nextMeaning ?? currentMeaning
      doc.senses = meaning ? [{ pos: '', meaning }] : []
    }
  } else if (nextMeaning !== undefined && doc.source === 'manual') {
    // 只改释义、词形没动：契约只写了「改词时」怎么处理，这里是合理的补充
    doc.senses = nextMeaning ? [{ pos: '', meaning: nextMeaning }] : []
  }

  try {
    return toWordDto(await repo.save(doc))
  } catch (err) {
    if (err?.code === 11000) {
      throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
    }
    throw err
  }
}

/**
 * DELETE /api/words/:id
 * 不级联删除任何阅读——阅读里的词汇是快照，删词不影响历史。
 */
export async function deleteWord({ userId, id }) {
  if (!mongoose.isValidObjectId(id)) throw wordNotFound()

  const removed = await repo.deleteByIdAndUser(id, userId)
  if (!removed) throw wordNotFound()

  const total = await repo.count({ userId })

  return { id: String(removed._id), total }
}
