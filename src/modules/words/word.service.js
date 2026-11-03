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
import { startOfLocalDay } from '../../shared/utils/time.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import {
  normalizeMeaningOrThrow,
  normalizeWordOrThrow,
} from '../../shared/utils/word-form.js'
import { findEntry } from '../dictionary/dictionary.loader.js'
import { toWordDto } from './word.dto.js'
import {
  buildCreatePayload,
  isCoveredByEntry,
  mergeSenses,
  resolveDuplicate,
} from './word-import.js'
import { planManualStatusUpdate } from './word-status.js'
import {
  DAILY_NEW_WORDS,
  DAILY_REVIEW_LIMIT,
  localDateKey,
  nextReviewAtAfterLapse,
  nextReviewAtAfterPass,
} from './review-schedule.js'
import { getWordRank } from './word-ranks.js'
import { wordRepository as repo } from './word.repository.js'
import {
  WORD_STATUSES,
  WORD_STATUS_FILTERS,
  WORD_STUDY_FILTERS,
  createWordSchema,
  reviewBatchSchema,
  reviewWordSchema,
  updateWordSchema,
} from './word.schema.js'
import { recordStudyActivity } from './study-stats.service.js'
import { settleDailyWords } from './word-settlement.js'

/** PATCH 时不允许修改的字段 */
const READONLY_FIELDS = ['source', 'dictionaryId', 'phonetic', 'senses']

/**
 * 把 `study` 参数翻成 Mongo 过滤条件，与 `WordDto.studyState` 一一对应。
 *
 * 判定顺序必须和 `deriveStudyState` 一致：墓碑 → 已掌握 → 今天加的 → 其余。
 * 顺序错了会出现「已掌握的词出现在复习中」「墓碑被算进新词」这类对不上的筛结果。
 */
function buildStudyFilter(study, today) {
  const notRemoved = { source: { $ne: 'basic-removed' } }

  switch (study) {
    case 'new':
      return { ...notRemoved, status: { $ne: 'mastered' }, createdAt: { $gte: today } }
    case 'reviewing':
      return { ...notRemoved, status: { $ne: 'mastered' }, createdAt: { $lt: today } }
    case 'mastered':
      return { ...notRemoved, status: 'mastered' }
    case 'removed':
      return { source: 'basic-removed' }
    default:
      return {}
  }
}

/**
 * GET /api/words
 *
 * 三个口径必须同时满足：
 *   counts      —— 全量，不带 q / status / study 筛选
 *   studyCounts —— 按学习阶段分档，供标签页显示数字
 *   total       —— 带 q、status（或 study）筛选
 *   page        —— 越界收敛到最后一页，并把收敛后的值返回
 *
 * 默认**不返回**基础词墓碑（`source='basic-removed'`）：那是用户在基础词页
 * 标「不认识」留下的占位记录，不是他的词，混在词库里会让「共 N 个词」对不上列表。
 * 想看就说 `includeRemoved=true`，或直接 `study=removed`。
 */
export async function listWords({ userId, query }) {
  // 先结算再查（md/56 §5.3）：用户第二天打开词库，昨天的新词要已经是「复习中」。
  // 两条 updateMany，命中 0 条时开销可忽略；放在这里而不是定时任务，
  // 是因为服务器重启不会漏、多实例也不会重复结算。
  await settleDailyWords(userId)

  const { q, page, pageSize, includeRemoved } = query
  // 未知值按「不筛选」处理：契约里没定义这个 400
  const status = WORD_STATUS_FILTERS.includes(query.status) ? query.status : 'all'
  const study = WORD_STUDY_FILTERS.includes(query.study) ? query.study : 'all'
  const today = startOfLocalDay(new Date())

  const filter = { userId }

  if (study !== 'all') {
    // study 有值时优先于 status：两者是两套口径，同时传只会让人猜哪个生效
    Object.assign(filter, buildStudyFilter(study, today))
  } else {
    if (status !== 'all') filter.status = status
    // 默认排除墓碑；study=removed 走的是另一个分支，不受这里影响
    if (!includeRemoved) filter.source = { $ne: 'basic-removed' }
  }

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

  // 两套计数并发取：两者互不依赖，串行只是白等一个来回
  const [statusRows, studyRows] = await Promise.all([
    repo.countByStatus(userId, { includeRemoved }),
    repo.countByStudyState(userId, today),
  ])

  return {
    // 不写 `items.map(toWordDto)`：map 会把下标当第二参传进去，
    // 而 toWordDto 的第二参是 options，将来加字段时很容易被下标悄悄污染
    items: items.map((item) => toWordDto(item)),
    total,
    page: currentPage,
    pageSize,
    counts: foldCounts(statusRows),
    studyCounts: foldStudyCounts(studyRows),
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

/**
 * 把 `countByStudyState` 的聚合结果折成五档（md/22 第 95 行 ②）。
 *
 * 判定顺序与 `deriveStudyState` 一致，逐条对应它不可能同时成立的四个分支：
 *   墓碑 → 已掌握 → 今天加的 → 其余。
 *
 * `all` **不含** `removed`：标签页「全部」点进去发的是不带参数的请求，
 * 默认就排除墓碑；把墓碑算进 all 会让标签上的数字和列表条数对不上。
 * `removed` 单独成档，是「不认识」入口自己的数字。
 */
function foldStudyCounts(rows) {
  const counts = { all: 0, new: 0, reviewing: 0, mastered: 0, removed: 0 }

  for (const row of rows) {
    const { removed, status, today } = row._id

    if (removed) {
      counts.removed += row.n
      continue
    }

    if (status === 'mastered') counts.mastered += row.n
    else if (today) counts.new += row.n
    else counts.reviewing += row.n

    counts.all += row.n
  }

  return counts
}

/**
 * 五档学习状态计数（md/61）。批量改状态后要立刻回新的标签数字，
 * 前端不必为了刷新计数再拉一次列表。
 *
 * 与 `listWords` 的 `studyCounts` 共用 `foldStudyCounts`，口径不会分叉。
 */
export async function buildStudyCounts(userId, now = new Date()) {
  const today = startOfLocalDay(now)
  return foldStudyCounts(await repo.countByStudyState(userId, today))
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
 * 手填词落库：命中词库就用词库义项（带词性、音标），用户释义按规则合并（md/51）。
 *
 * `previousSenses` 只在「词形没变、只改释义」时传：之前手动加的、
 * 词库覆盖不到的释义（比如自己的记法）不能因为改一次释义就消失。
 * 改词形时不传——旧词的义项跟新词无关，带过来只会污染新词。
 */
function applyManualSenses(doc, { word, meaning, previousSenses = [] }) {
  const entry = findEntry(word)

  if (!entry?.senses?.length) {
    doc.dictionaryId = null
    doc.phonetic = null
    doc.senses = meaning ? [{ pos: '', meaning }] : []
    return
  }

  doc.dictionaryId = entry.id ?? null
  doc.phonetic = {
    uk: entry.phonetic?.uk ?? null,
    us: entry.phonetic?.us ?? null,
  }

  const senses = mergeSenses(entry, meaning)
  const nextMeaning = String(meaning ?? '').trim()

  for (const sense of previousSenses) {
    const text = String(sense?.meaning ?? '').trim()

    if (!text || text === nextMeaning) continue
    // 词库自己的义项会被 mergeSenses 带回来，不用重复追加
    if (isCoveredByEntry(entry, text)) continue
    if (senses.some((item) => String(item.meaning).trim() === text)) continue

    senses.push({ pos: '', meaning: text })
  }

  doc.senses = senses
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

  // 墓碑不是普通词：只改 status 会让 source 仍是 basic-removed，
  // 前端看起来「没变」。要复活必须显式走批量 restore 或基础词页恢复。
  // 放行 new 是因为编辑弹窗可能原样回传当前状态，那是个幂等空操作。
  if (
    parsed.status !== undefined &&
    parsed.status !== 'new' &&
    doc.source === 'basic-removed'
  ) {
    throw conflict(
      ERROR_CODES.BASIC_WORD_ALREADY_REMOVED,
      '这个词已被标记为不认识，请先恢复后再修改状态',
      'status',
    )
  }

  const nextWord =
    parsed.word !== undefined ? normalizeWordOrThrow(parsed.word) : doc.word
  const nextMeaning =
    parsed.meaning !== undefined
      ? normalizeMeaningOrThrow(parsed.meaning)
      : undefined

  if (parsed.status !== undefined) {
    Object.assign(doc, planManualStatusUpdate(doc, parsed.status))
    doc.status = parsed.status
  }

  const wordChanged = nextWord !== doc.word

  if (wordChanged) {
    if (await repo.existsByWord(userId, nextWord, doc._id)) {
      throw conflict(ERROR_CODES.WORD_EXISTS, '这个单词已经添加过了', 'word')
    }

    // 只改词形、没传新释义时，带过去的是「用户自己写的那条」（pos 为空），
    // 不是 senses[0]——词库命中时第一条是词库释义，跟新词无关
    const currentMeaning =
      [...(doc.senses ?? [])].reverse().find((sense) => !sense.pos)?.meaning ?? ''
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
      applyManualSenses(doc, {
        word: nextWord,
        meaning: nextMeaning ?? currentMeaning,
      })
    }
  } else if (nextMeaning !== undefined && doc.source === 'manual') {
    // 只改释义、词形没动：契约只写了「改词时」怎么处理，这里是合理的补充。
    // 重新过一遍词库，编辑一次不会把词性和完整义项又弄丢（md/51）
    applyManualSenses(doc, {
      word: doc.word,
      meaning: nextMeaning,
      previousSenses: doc.senses ?? [],
    })
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

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * GET /api/words/daily-plan（md/56 §8.1）
 *
 * 回答两个问题：今天的复习队列还剩多少、今天还能加几个新词。
 *
 * 这里**先结算再统计**：如果不结算，昨天的新词今天还算 `new`，
 * 用户早上打开看到「待复习 0 个」，会以为系统坏了。
 */
export async function getDailyPlan({ userId, now = new Date() }) {
  await settleDailyWords(userId, now)

  const today = startOfLocalDay(now)
  const tomorrow = new Date(today.getTime() + DAY_MS)

  const [words, remaining, doneToday, addedToday] = await Promise.all([
    repo.findDueForReview({ userId, now, limit: DAILY_REVIEW_LIMIT }),
    repo.countDueForReview({ userId, now }),
    repo.countReviewedBetween({ userId, from: today, to: tomorrow }),
    repo.countCreatedBetween({ userId, from: today, to: tomorrow }),
  ])

  return {
    date: localDateKey(today),
    newWords: {
      quota: DAILY_NEW_WORDS,
      addedToday,
      remaining: Math.max(0, DAILY_NEW_WORDS - addedToday),
    },
    review: {
      // 现在到期、还没复习的总量（可能上千，积压越久越大）
      remaining,
      // 今天建议复习几个：积压再多，一天也只捞上限那么多
      today: Math.min(remaining, DAILY_REVIEW_LIMIT),
      // 今天复习过多少个词。包含在文章里顺带复习到的池内词，
      // 所以它可能大于「今天原本到期的数量」——前端不要拿它反推 today
      doneToday,
      words: words.map((item) => toWordDto(item)),
    },
  }
}

/**
 * POST /api/words/:id/review（md/56 §7）
 *
 * 自评是唯一会推进复习轮次的入口。文章的提交练习走另一条路径
 * （reading.service 按 usedWords 回写），两者互不覆盖。
 */
export async function reviewWord({ userId, id, body }) {
  const parsed = parseOrThrow(reviewWordSchema, body)

  if (!mongoose.isValidObjectId(id)) throw wordNotFound()

  const doc = await repo.findByIdAndUser(id, userId)
  if (!doc) throw wordNotFound()

  // 基础词页的墓碑记录不是「用户的词」，让它可以被复习等于把它重新激活，
  // 用户标过的「不认识」会凭空失效
  if (doc.source === 'basic-removed') {
    throw badRequest('这个词在基础词表里被标为「不认识」，不能作为复习对象', 'id')
  }

  const now = new Date()
  // 只有「通过且到掌握线」才算一个新晋已掌握，没记住永远是 0
  let mastered = 0

  if (parsed.result === 'lapse') {
    await repo.applyLapse({
      userId,
      word: doc.word,
      nextReviewAt: nextReviewAtAfterLapse(now),
      at: now,
    })
  } else {
    const stage = (doc.reviewStage ?? 0) + 1
    const nextReviewAt = nextReviewAtAfterPass(stage, now)

    if (nextReviewAt === null) {
      await repo.applyMastery({ userId, word: doc.word, stage, at: now })
      mastered = 1
    } else {
      await repo.applyReviewPass({
        userId,
        word: doc.word,
        stage,
        nextReviewAt,
        at: now,
      })
    }
  }

  await recordStudyActivity({ userId, reviewed: 1, mastered, at: now })

  // 重新读一次再转 DTO：用算好的结果构造，避免和 repository 的写逻辑重复一遍
  return toWordDto(await repo.findByIdAndUser(id, userId))
}

/**
 * POST /api/words/review/batch（md/56 §8.1）
 *
 * 一天的复习上限是 50 个词，逐个点「通过」要发 50 次请求。
 * 这个接口把它们合成一次，语义与单个自评完全一致。
 *
 * **单项失败不拖垮整批**：不存在的 id、墓碑词都进 `skipped` 并说明原因，
 * 其余照常写。批量接口最忌讳「一条不对就全失败」——用户点了 30 个，
 * 其中一个已被删掉，前面 29 次操作白做。
 *
 * 同一个 id 传两次以**最后一次**为准：连点两次「通过」不该把轮次推两轮，
 * 而 bulkWrite 里同一 filter 出现两条会真的写两次。
 */
export async function reviewWords({ userId, body }) {
  const parsed = parseOrThrow(reviewBatchSchema, body)
  const now = new Date()

  const results = new Map()
  for (const item of parsed.items) results.set(item.id, item.result)

  const validIds = [...results.keys()].filter((id) => mongoose.isValidObjectId(id))
  const docs = await repo.findByIdsAndUser(validIds, userId, 'word status reviewStage source')
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]))

  const skipped = []
  const updates = []
  const writtenIds = []

  // 按请求顺序遍历：skipped 的顺序要和用户点的顺序一致，
  // 否则前端按 id 回填时对不上号
  for (const [id, result] of results) {
    // 非法 id 与「查不到」对外是同一个结果：这个词不在你的库里
    if (!mongoose.isValidObjectId(id)) {
      skipped.push({ id, reason: 'NOT_FOUND' })
      continue
    }

    const doc = byId.get(id)

    if (!doc) {
      skipped.push({ id, reason: 'NOT_FOUND' })
      continue
    }

    // 与单个自评同一口径：墓碑词不能被自评复活，否则用户标过的「不认识」凭空失效
    if (doc.source === 'basic-removed') {
      skipped.push({ id, reason: 'BASIC_REMOVED' })
      continue
    }

    const lapse = result === 'lapse'
    const stage = lapse ? 0 : (doc.reviewStage ?? 0) + 1

    updates.push({
      word: doc.word,
      stage,
      nextReviewAt: lapse ? nextReviewAtAfterLapse(now) : nextReviewAtAfterPass(stage, now),
      lapse,
    })
    writtenIds.push(id)
  }

  if (updates.length) {
    await repo.applyReviewBatch({ userId, updates, at: now })

    await recordStudyActivity({
      userId,
      reviewed: updates.length,
      mastered: updates.filter((item) => !item.lapse && item.nextReviewAt === null).length,
      at: now,
    })
  }

  // 回写后的状态再读一次：前端据此就地更新列表，不用整页重拉
  const updated = writtenIds.length
    ? await repo.findByIdsAndUser(writtenIds, userId)
    : []

  return {
    updated: updates.length,
    skipped,
    words: updated.map((item) => toWordDto(item)),
  }
}
