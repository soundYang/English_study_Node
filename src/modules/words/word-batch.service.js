import { config } from '../../config/index.js'
import { ApiError, ERROR_CODES } from '../../shared/errors.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { checkMeaning, checkWord } from '../../shared/utils/word-form.js'
import { findEntry } from '../dictionary/dictionary.loader.js'
import { buildSummary, toWordDto } from './word.dto.js'
import { withWordBanks } from './word.service.js'
import {
  buildCreatePayload,
  normalizeStatus,
  parseWordText,
  resolveDuplicate,
} from './word-import.js'
import { wordRepository as repo } from './word.repository.js'
import { batchWordsSchema, checkWordsSchema } from './word.schema.js'

/**
 * 批量导入与提交前预检（md/44 §5.4 / §5.5）。
 *
 * 两条铁律：
 *   1. **单条失败不整批失败**：非法词、超限、词库没收录都进 `errors[]`，
 *      其余条目照常写入。200 条里错 1 条就全丢，比不支持批量更糟。
 *   2. **写库只发两次请求**：`insertMany` + `bulkWrite`。逐条 save 在 200 条时
 *      是 200 次往返，批量就失去了意义。
 */

/** 批内重复的单条错误码；不是 HTTP 错误码，只用来区分失败原因 */
const DUPLICATE_IN_REQUEST = 'DUPLICATE_IN_REQUEST'

/** POST /api/words/batch */
export async function importWords({ userId, body }) {
  const parsed = parseOrThrow(batchWordsSchema, body)
  const { candidates, errors, skipped, total } = prepareEntries(parsed)

  const existingDocs = await repo.findByWords(
    userId,
    candidates.map((candidate) => candidate.word),
    null,
  )
  const existingByWord = new Map(existingDocs.map((doc) => [doc.word, doc]))

  const plans = classify({ userId, candidates, existingByWord, onDuplicate: parsed.onDuplicate, errors })
  // 上限要在 dryRun 之前算：预览也必须告诉用户「这几条会因满库失败」
  const creates = await limitCreates({
    userId,
    createPlans: plans.filter((plan) => plan.action === 'create'),
    errors,
  })

  if (parsed.dryRun) {
    return buildPreview({ plans, errors, skipped, total })
  }

  await writeCreates({
    userId,
    creates,
    errors,
    onDuplicate: parsed.onDuplicate,
  })

  const updateOps = plans
    .filter((plan) => plan.update)
    .map((plan) => ({
      updateOne: {
        filter: { _id: plan.existing._id, userId },
        update: { $set: plan.update },
      },
    }))

  if (updateOps.length) await repo.bulkUpdate(updateOps)

  // 一次回查拿最终状态：插入的、被别的请求抢先插入的、合并过的都在这一份里
  const finalDocs = await repo.findByWords(
    userId,
    plans.map((plan) => plan.candidate.word),
    null,
  )
  const finalByWord = new Map(finalDocs.map((doc) => [doc.word, doc]))

  const items = []
  let created = 0
  let updated = 0
  let skippedCount = skipped.length

  for (const plan of plans) {
    const doc = finalByWord.get(plan.candidate.word)

    if (plan.action === 'create') {
      // 超限被拦下的条目已经在 limitCreates 里记过 WORD_LIMIT_REACHED，
      // 这里不能再补一条 INTERNAL_ERROR
      if (plan.blocked) continue

      if (!doc) {
        // 走到这里说明两次插入都失败且没被记成重复
        errors.push({
          index: plan.candidate.index,
          word: plan.candidate.word,
          code: ERROR_CODES.INTERNAL_ERROR,
          message: '保存失败，请稍后重试',
        })
        continue
      }

      created += 1
      items.push(toWordDto(doc))
      continue
    }

    if (plan.update) {
      if (!doc) {
        errors.push({
          index: plan.candidate.index,
          word: plan.candidate.word,
          code: ERROR_CODES.WORD_NOT_FOUND,
          message: '单词已被删除，跳过',
        })
        continue
      }

      updated += 1
      items.push(toWordDto(doc))
      continue
    }

    // onDuplicate=skip / auto 下无需改动
    skippedCount += 1
  }

  return {
    created,
    updated,
    skipped: skippedCount,
    failed: errors.length,
    total,
    items: await withWordBanks(userId, items),
    skippedItems: skipped,
    errors,
  }
}

/** POST /api/words/check */
export async function checkWords({ userId, body }) {
  const parsed = parseOrThrow(checkWordsSchema, body)
  const defaultStatus = normalizeStatus(parsed.status)

  const checkedByIndex = new Map()
  const errors = []

  parsed.words.forEach((raw, index) => {
    const checked = checkWord(raw)

    if (!checked.ok) {
      errors[index] = {
        word: checked.word || String(raw ?? ''),
        valid: false,
        reason: checked.message,
        exists: false,
        dictionary: null,
        action: 'invalid',
      }
      return
    }

    checkedByIndex.set(index, checked.word)
  })

  const unique = [...new Set(checkedByIndex.values())]
  const docs = await repo.findByWords(userId, unique, null)
  const byWord = new Map(docs.map((doc) => [doc.word, doc]))
  const infoByWord = new Map()

  for (const word of unique) {
    const existing = byWord.get(word)
    const entry = findEntry(word)
    const dictionary = entry?.senses?.length
      ? {
          found: true,
          id: entry.id ?? null,
          summary: buildSummary(entry.senses),
          senseCount: entry.senses.length,
        }
      : { found: false, id: null, summary: '', senseCount: 0 }

    infoByWord.set(word, {
      valid: true,
      exists: Boolean(existing),
      wordId: existing ? String(existing._id) : null,
      status: existing?.status ?? null,
      source: existing?.source ?? null,
      dictionary,
      // 预检永远按 auto 策略给建议：前端要展示的是「提交后会发生什么」
      action: existing
        ? resolveDuplicate(existing, { status: defaultStatus }).action
        : 'create',
    })
  }

  return {
    items: parsed.words.map((raw, index) =>
      errors[index] ?? { word: checkedByIndex.get(index), ...infoByWord.get(checkedByIndex.get(index)) },
    ),
  }
}

/**
 * 把两种输入（对象数组 / 粘贴文本）统一成候选条目。
 *
 * 校验失败与批内重复都在这一层落地：后面的分类只看合法候选，
 * 不会再因为一条脏数据中断整批。
 */
function prepareEntries({ words, text, status: defaultStatus }) {
  const rawEntries = words?.length
    ? words.map((item, index) => ({
        index,
        raw: item.word,
        word: item.word,
        meaning: item.meaning,
        status: item.status,
        source: item.source,
      }))
    : parseWordText(text)

  const candidates = []
  const errors = []
  const skipped = []
  const seen = new Set()

  for (const raw of rawEntries) {
    const checked = checkWord(raw.word)

    if (!checked.ok) {
      errors.push({
        index: raw.index,
        word: truncate(checked.word || String(raw.raw ?? '')),
        code: ERROR_CODES.INVALID_REQUEST,
        message: checked.message,
        field: 'word',
      })
      continue
    }

    if (seen.has(checked.word)) {
      skipped.push({
        index: raw.index,
        word: checked.word,
        reason: DUPLICATE_IN_REQUEST,
      })
      continue
    }

    seen.add(checked.word)

    const source = raw.source === 'dictionary' ? 'dictionary' : 'manual'
    const meaningCheck = source === 'manual'
      ? checkMeaning(raw.meaning)
      : { ok: true, meaning: '' }

    if (!meaningCheck.ok) {
      errors.push({
        index: raw.index,
        word: checked.word,
        code: ERROR_CODES.INVALID_REQUEST,
        message: meaningCheck.message,
        field: 'meaning',
      })
      continue
    }

    candidates.push({
      index: raw.index,
      word: checked.word,
      status: normalizeStatus(raw.status ?? defaultStatus),
      source,
      meaning: meaningCheck.meaning,
    })
  }

  return { candidates, errors, skipped, total: rawEntries.length }
}

/**
 * 给每个候选定动作。新建的在这里就把 payload 组装好（词库回查是纯内存操作），
 * 后面写库时不再重复查词库。
 */
function classify({ userId, candidates, existingByWord, onDuplicate, errors }) {
  const plans = []

  for (const candidate of candidates) {
    const existing = existingByWord.get(candidate.word)

    if (!existing) {
      try {
        plans.push({
          candidate,
          existing: null,
          action: 'create',
          payload: buildCreatePayload({
            userId,
            word: candidate.word,
            status: candidate.status,
            source: candidate.source,
            meaning: candidate.meaning,
          }),
          update: null,
        })
      } catch (err) {
        errors.push(toEntryError(candidate, err))
      }
      continue
    }

    if (onDuplicate === 'error') {
      errors.push({
        index: candidate.index,
        word: candidate.word,
        code: ERROR_CODES.WORD_EXISTS,
        message: '这个单词已经添加过了',
        field: 'word',
      })
      continue
    }

    if (onDuplicate === 'skip') {
      plans.push({ candidate, existing, action: 'kept', payload: null, update: null })
      continue
    }

    const { action, update } = resolveDuplicate(existing, {
      status: candidate.status,
      meaning: candidate.meaning,
    })

    plans.push({ candidate, existing, action, payload: null, update })
  }

  return plans
}

/**
 * 词库上限（md/44 §5.6）：只放行前 remaining 条新建。
 * 合并已有词不占名额，classify 阶段已分流，不会进这里。
 */
async function limitCreates({ userId, createPlans, errors }) {
  if (!createPlans.length) return []

  const limit = config.wordLibraryLimit
  if (!limit || limit <= 0) return createPlans

  const remaining = remainingLibrarySlots(await repo.count({ userId }), limit)

  for (const plan of createPlans.slice(remaining)) {
    plan.blocked = true
    errors.push({
      index: plan.candidate.index,
      word: plan.candidate.word,
      code: ERROR_CODES.WORD_LIMIT_REACHED,
      message: `个人词库已达上限（${limit} 词），请先删除一些再添加`,
      field: 'word',
    })
  }

  return createPlans.slice(0, remaining)
}

/** dryRun 响应：只报告会发生什么，不写库 */
function buildPreview({ plans, errors, skipped, total }) {
  const preview = plans.map((plan) => {
    if (!plan.existing) {
      return {
        word: plan.candidate.word,
        action: plan.blocked ? 'error' : 'create',
        reason: plan.blocked ? ERROR_CODES.WORD_LIMIT_REACHED : undefined,
        status: plan.payload.status,
        source: plan.payload.source,
        summary: buildSummary(plan.payload.senses),
        wordId: null,
      }
    }

    return {
      word: plan.candidate.word,
      action: plan.action,
      status: plan.update?.status ?? plan.existing.status,
      source: plan.update?.source ?? plan.existing.source,
      summary: buildSummary(plan.update?.senses ?? plan.existing.senses),
      wordId: String(plan.existing._id),
    }
  })

  return {
    dryRun: true,
    wouldCreate: plans.filter((plan) => plan.action === 'create' && !plan.blocked).length,
    wouldUpdate: plans.filter((plan) => plan.update).length,
    wouldSkip: plans.filter((plan) => !plan.update && plan.action !== 'create').length
      + skipped.length,
    invalid: errors.length,
    total,
    preview,
    skippedItems: skipped,
    errors,
  }
}

/**
 * 批量新建。正常情况一次 insertMany；撞上唯一索引（并发）时
 * 回查一次，把「别人刚写进去的」转成合并、其余重试一次。
 *
 * @returns {string[]} 本次真正由这条请求写入的词
 */
async function writeCreates({ userId, creates, errors, onDuplicate }) {
  if (!creates.length) return []

  try {
    const docs = await repo.insertMany(creates.map((plan) => plan.payload))

    return docs.map((doc) => doc.word)
  } catch (err) {
    if (!isDuplicateError(err)) throw err

    const inserted = (err.insertedDocs ?? []).map((doc) => doc.word)
    await settleRacedCreates({ userId, creates, inserted, errors, onDuplicate })

    return inserted
  }
}

/** 11000 之后的收尾：回查 → 已有的按合并策略处理 → 缺的再插一次 */
async function settleRacedCreates({ userId, creates, inserted, errors, onDuplicate }) {
  const docs = await repo.findByWords(
    userId,
    creates.map((plan) => plan.candidate.word),
    null,
  )
  const byWord = new Map(docs.map((doc) => [doc.word, doc]))

  // 驱动没回 insertedDocs 时，无法区分「本批刚写入的」和「别人抢先写入的」。
  // 一律按已写入处理：两种情况的最终结果都是「词已在库里」，
  // 这里宁可少做一次合并，也不能误报 WORD_EXISTS 把用户自己的词标成失败
  if (!inserted.length) {
    for (const doc of docs) inserted.push(doc.word)
  }

  const missing = []
  const updateOps = []

  for (const plan of creates) {
    const doc = byWord.get(plan.candidate.word)

    if (!doc) {
      missing.push(plan)
      continue
    }

    if (inserted.includes(doc.word)) continue

    if (onDuplicate === 'error') {
      errors.push({
        index: plan.candidate.index,
        word: plan.candidate.word,
        code: ERROR_CODES.WORD_EXISTS,
        message: '这个单词已经添加过了',
        field: 'word',
      })
      continue
    }

    // skip 策略下别人写入的就算数，不再动它
    if (onDuplicate === 'skip') continue

    const { update } = resolveDuplicate(doc, {
      status: plan.candidate.status,
      meaning: plan.candidate.meaning,
    })

    if (update) {
      updateOps.push({
        updateOne: { filter: { _id: doc._id, userId }, update: { $set: update } },
      })
    }
  }

  if (updateOps.length) await repo.bulkUpdate(updateOps)

  if (!missing.length) return

  try {
    const docs = await repo.insertMany(missing.map((plan) => plan.payload))
    inserted.push(...docs.map((doc) => doc.word))
  } catch (err) {
    if (!isDuplicateError(err)) throw err

    for (const plan of missing) {
      errors.push({
        index: plan.candidate.index,
        word: plan.candidate.word,
        code: ERROR_CODES.WORD_EXISTS,
        message: '这个单词已经添加过了',
        field: 'word',
      })
    }
  }
}

/** 只认「唯一索引冲突」；其它写错误必须冒出去，不能被当成重复吞掉 */
function isDuplicateError(err) {
  if (err?.code === 11000) return true

  const writeErrors = err?.writeErrors ?? []

  return writeErrors.some((item) => (item?.code ?? item?.err?.code) === 11000)
}

function toEntryError(candidate, err) {
  if (err instanceof ApiError) {
    return {
      index: candidate.index,
      word: candidate.word,
      code: err.code,
      message: err.message,
      field: err.field || undefined,
    }
  }

  return {
    index: candidate.index,
    word: candidate.word,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: '保存失败，请稍后重试',
  }
}

/** 错误里回显的原始输入不该比字段本身还长 */
function truncate(raw, max = 45) {
  const text = String(raw ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 词库上限的剩余名额；0 或负数表示不限，返回 Infinity */
export function remainingLibrarySlots(current, limit = config.wordLibraryLimit) {
  if (!limit || limit <= 0) return Infinity

  return Math.max(0, limit - current)
}
