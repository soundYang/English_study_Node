import mongoose from 'mongoose'

import { config } from '../../config/index.js'
import {
  ApiError,
  ERROR_CODES,
  badRequest,
  conflict,
  wordLimitReached,
  wordNotFound,
} from '../../shared/errors.js'
import { escapeRegex } from '../../shared/utils/regex.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import {
  normalizeMeaningOrThrow,
  normalizeWordOrThrow,
} from '../../shared/utils/word-form.js'
import { toWordDto } from './word.dto.js'
import { buildCreatePayload, resolveDuplicate } from './word-import.js'
import { getWordRank } from './word-ranks.js'
import { wordRepository as repo } from './word.repository.js'
import {
  WORD_STATUSES,
  WORD_STATUS_FILTERS,
  createWordSchema,
  updateWordSchema,
} from './word.schema.js'

/** PATCH 时不允许修改的字段 */
const READONLY_FIELDS = ['source', 'dictionaryId', 'phonetic', 'senses']

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

  return {
    items: items.map(toWordDto),
    total,
    page: currentPage,
    pageSize,
    counts: foldCounts(rows),
  }
}

/**
 * 把 `countByStatus` 的聚合结果折成四个键。
 *
 * `all` 是求和而**不是**一次单独 count：两个数字走两次查询，
 * 中间有写入时会出现 all ≠ 三档之和，页面的自检不变量就破了。
 */
function foldCounts(rows) {
  const counts = { all: 0, mastered: 0, learning: 0, new: 0 }

  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.n
    counts.all += row.n
  }

  return counts
}

/** 词库全量快照（`includeCounts` 用，md/44 §5.7） */
async function librarySnapshot(userId) {
  const counts = foldCounts(await repo.countByStatus(userId))

  return { counts, total: counts.all }
}

/**
 * POST /api/words
 *
 * 返回 `{ created, dto }`：`created=false` 表示走的是重复词合并（HTTP 200），
 * `created=true` 是新建（HTTP 201）。响应体本身仍是扁平 WordDto——
 * 前端 `result.item.word` 依赖它，不能改成信封（md/44 §3.1）。
 */
export async function createWord({ userId, body }) {
  const parsed = parseOrThrow(createWordSchema, body)
  const word = normalizeWordOrThrow(parsed.word)

  // source 只认 dictionary，其它一律按 manual
  const source = parsed.source === 'dictionary' ? 'dictionary' : 'manual'
  // 只有手填分支会用到释义；dictionary 分支忽略请求体（契约 §3.2 第 4 条）
  const meaning = source === 'manual'
    ? normalizeMeaningOrThrow(parsed.meaning)
    : ''
  const options = {
    userId,
    word,
    status: parsed.status,
    meaning,
    onDuplicate: parsed.onDuplicate,
    includeCounts: parsed.includeCounts,
  }

  const existing = await repo.findOneByWord(userId, word)
  if (existing) return resolveExistingWord({ ...options, existing })

  await assertLibraryHasRoom(userId)

  const payload = buildCreatePayload({
    userId,
    word,
    status: parsed.status,
    source,
    meaning,
  })

  try {
    const doc = await repo.create(payload)

    return {
      created: true,
      dto: await decorate(toWordDto(doc), { action: 'created', ...options }),
    }
  } catch (err) {
    if (err?.code !== 11000) throw err

    // 并发下两个请求同时过了上面的存在检查，唯一索引兜底成功后
    // 不能再直接 409：串行请求看到的是合并结果，并行也必须一致
    const raced = await repo.findOneByWord(userId, word)
    if (!raced) {
      throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
    }

    return resolveExistingWord({ ...options, existing: raced })
  }
}

/** 已存在词的统一出口：按策略返回原样 / 合并 / 409 */
async function resolveExistingWord({
  userId,
  existing,
  status,
  meaning,
  onDuplicate,
  includeCounts,
}) {
  if (onDuplicate === 'error') {
    throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
  }

  if (onDuplicate === 'skip') {
    return {
      created: false,
      dto: await decorate(toWordDto(existing), {
        action: 'kept',
        userId,
        includeCounts,
      }),
    }
  }

  const { action, update } = resolveDuplicate(existing, { status, meaning })

  if (update) {
    existing.set(update)
    await repo.save(existing)
  }

  return {
    created: false,
    dto: await decorate(toWordDto(existing), {
      action,
      userId,
      includeCounts,
    }),
  }
}

/**
 * 给 DTO 补合并信息（只出现在创建响应里，列表接口不受影响）。
 *
 * `duplicate` 单独给一个布尔：前端不该靠 action 字面量判断
 * 「这次是不是新词」——action 以后可能加值。
 */
async function decorate(dto, { action, userId, includeCounts }) {
  const result = { ...dto, action, duplicate: action !== 'created' }

  if (includeCounts) {
    const { counts, total } = await librarySnapshot(userId)
    result.counts = counts
    result.total = total
  }

  return result
}

/**
 * 词库上限。只拦新建——合并已有词不增加条数，
 * 否则用户在满库时连「把标错的词改回来」都做不到。
 */
async function assertLibraryHasRoom(userId) {
  const limit = config.wordLibraryLimit
  if (!limit || limit <= 0) return

  if ((await repo.count({ userId })) >= limit) throw wordLimitReached(limit)
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
    parsed.word !== undefined ? normalizeWordOrThrow(parsed.word) : doc.word
  const nextMeaning =
    parsed.meaning !== undefined
      ? normalizeMeaningOrThrow(parsed.meaning)
      : undefined

  if (parsed.status !== undefined) doc.status = parsed.status

  const wordChanged = nextWord !== doc.word

  if (wordChanged) {
    if (await repo.existsByWord(userId, nextWord, doc._id)) {
      throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
    }

    const currentMeaning = doc.senses?.[0]?.meaning ?? ''
    doc.word = nextWord
    // 词形变了，旧排名描述的已经不是这个词了；不改会一直按错的难度参与选池
    doc.cocaRank = getWordRank(nextWord)

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
