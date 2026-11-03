import { basicWordByWord } from '../basic-words/basic-words.catalog.js'
import { findEntry } from '../dictionary/dictionary.loader.js'
import { isSameLocalDay, startOfLocalDay } from '../../shared/utils/time.js'

/**
 * 批量修改学习状态的纯函数层（md/61）。
 *
 * 只做两件事：
 *   1. 单条 PATCH 与批量接口共用的「状态 → 排期字段」；
 *   2. 把「目标状态 + 当前文档」翻成一次 `$set`，或明确告诉调用方为什么跳过。
 *
 * 这里不碰 Mongo，也不碰 Express：service 负责读文档、写库、组装响应。
 * 这样迁移矩阵可以逐行写单测，不需要起内存数据库。
 */

/** 基础词墓碑的来源值；removed 是软移除，不是 status */
export const TOMBSTONE_SOURCE = 'basic-removed'

/** 批量接口允许的五个目标（md/61 §4.2） */
export const STATUS_BATCH_TARGETS = Object.freeze([
  'new',
  'learning',
  'mastered',
  'removed',
  'restore',
])

/** 逐条跳过原因；不是 HTTP 错误码，前端按字符串分支 */
export const STATUS_BATCH_SKIP_REASONS = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  BASIC_REMOVED: 'BASIC_REMOVED',
  NEW_STATE_ONLY_TODAY: 'NEW_STATE_ONLY_TODAY',
  FUNCTION_WORD_IMMUTABLE: 'FUNCTION_WORD_IMMUTABLE',
  BASIC_WORD_READONLY: 'BASIC_WORD_READONLY',
})

/**
 * 手动改状态的排期副作用（md/56 §7）。
 *
 * 单条 `PATCH /api/words/:id` 与批量接口都走这里，避免两套逻辑分叉：
 *   mastered → 退出复习队列，记下掌握时刻
 *   learning → 立刻进队列（用户说「我要复习它」，那就今天开始）
 *   new      → 退出队列，等次日结算再把它推回 learning
 *
 * @param {object} doc 至少带 `reviewStage` / `masteredAt`
 * @param {'new'|'learning'|'mastered'} status
 * @param {Date} now
 * @returns {object} 要合并进文档 / `$set` 的字段
 */
export function planManualStatusUpdate(doc, status, now = new Date()) {
  if (status === 'mastered') {
    return {
      nextReviewAt: null,
      masteredAt: doc.masteredAt ?? now,
    }
  }

  // 一旦不是 mastered，掌握时刻就该清掉，否则历史里会留一条对不上的记录
  const update = { masteredAt: null }

  if (status === 'learning') {
    update.reviewStage = doc.reviewStage ?? 0
    update.nextReviewAt = startOfLocalDay(now)
    return update
  }

  update.nextReviewAt = null
  return update
}

/**
 * 墓碑恢复后应该回到哪个来源（md/61 §5.3）。
 *
 * 墓碑只记了 `source='basic-removed'`，原始来源被覆盖。用义项里有没有
 * `pos=''` 判断用户是否手写过释义：有 → manual，否则词库有条目就 dictionary。
 */
function restoreSource(doc, entry) {
  const userAuthored = (doc.senses ?? []).some((sense) => !sense.pos)
  if (userAuthored) return 'manual'
  return entry?.senses?.length ? 'dictionary' : 'manual'
}

/**
 * 把一个词迁到目标状态。
 *
 * @param {object} doc Word 文档（lean 或 Mongoose 文档均可）
 * @param {'new'|'learning'|'mastered'|'removed'|'restore'} target
 * @param {Date} now 整批只取一次，避免跨零点落到不同日期
 * @returns {{action:'changed', update:object}
 *          |{action:'unchanged'}
 *          |{action:'skipped', reason:string}}
 */
export function planStatusTransition(doc, target, now = new Date()) {
  const today = startOfLocalDay(now)
  const tombstone = doc.source === TOMBSTONE_SOURCE

  if (target === 'restore') {
    if (!tombstone) return { action: 'unchanged' }

    const entry = findEntry(doc.word)
    const update = {
      source: restoreSource(doc, entry),
      status: 'learning',
      reviewStage: 0,
      nextReviewAt: today,
      masteredAt: null,
    }

    // 墓碑一般带着移除时的快照；只有老数据 / 手填空释义才需要补
    if (!(doc.senses ?? []).length && entry?.senses?.length) {
      Object.assign(update, {
        dictionaryId: entry.id ?? null,
        phonetic: {
          uk: entry.phonetic?.uk ?? null,
          us: entry.phonetic?.us ?? null,
        },
        senses: entry.senses.map((sense) => ({
          pos: sense.pos ?? '',
          meaning: sense.meaning,
        })),
      })
    }

    return { action: 'changed', update }
  }

  if (tombstone) {
    // 已经是目标状态：幂等空操作
    if (target === 'removed') return { action: 'unchanged' }

    // 墓碑不能被 new / learning / mastered 隐式复活，必须显式 restore
    return { action: 'skipped', reason: STATUS_BATCH_SKIP_REASONS.BASIC_REMOVED }
  }

  if (target === 'removed') {
    const entry = basicWordByWord.get(doc.word)

    // 与基础词页 assertRemovable 同口径：功能词缺了句子写不出来
    if (entry?.isFunctionWord) {
      return {
        action: 'skipped',
        reason: STATUS_BATCH_SKIP_REASONS.FUNCTION_WORD_IMMUTABLE,
      }
    }

    // 日历词 / 缩写只读，不允许从个人词库里移除
    if (entry && !entry.removable) {
      return {
        action: 'skipped',
        reason: STATUS_BATCH_SKIP_REASONS.BASIC_WORD_READONLY,
      }
    }

    return {
      action: 'changed',
      update: {
        source: TOMBSTONE_SOURCE,
        status: 'new',
        nextReviewAt: null,
        masteredAt: null,
      },
    }
  }

  // target ∈ new / learning / mastered
  if (target === 'new') {
    const created = startOfLocalDay(doc.createdAt)

    // studyState 的 new 是「今天创建」派生出来的；老词改 status 也回不去
    if (!created || created.getTime() < today.getTime()) {
      return {
        action: 'skipped',
        reason: STATUS_BATCH_SKIP_REASONS.NEW_STATE_ONLY_TODAY,
      }
    }
  }

  const update = {
    status: target,
    ...planManualStatusUpdate(doc, target, now),
  }

  if (
    target === 'new' &&
    doc.status === 'new' &&
    !doc.nextReviewAt &&
    !doc.masteredAt
  ) {
    return { action: 'unchanged' }
  }

  if (
    target === 'learning' &&
    doc.status === 'learning' &&
    isSameLocalDay(doc.nextReviewAt, today) &&
    !doc.masteredAt
  ) {
    return { action: 'unchanged' }
  }

  if (target === 'mastered' && doc.status === 'mastered' && !doc.nextReviewAt) {
    return { action: 'unchanged' }
  }

  return { action: 'changed', update }
}
