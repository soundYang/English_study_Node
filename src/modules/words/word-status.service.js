import mongoose from 'mongoose'

import { parseOrThrow } from '../../shared/utils/validation.js'
import { basicWordMarkRepository as markRepo } from '../basic-words/basic-word-mark.repository.js'
import { deriveStudyState, toWordDto } from './word.dto.js'
import { wordRepository as repo } from './word.repository.js'
import { batchStatusSchema } from './word.schema.js'
import { planStatusTransition } from './word-status.js'
import { buildStudyCounts, withWordBanks } from './word.service.js'

/**
 * POST /api/words/status/batch（md/61）
 *
 * 一条请求把用户勾选的多个词迁到同一个目标状态。
 *
 * 与批量自评一样，**单项失败不拖垮整批**：非法 id、别人的 id、墓碑词
 * 想直接改成 learning，都进 `skipped` 并说明原因，其余照常写。
 *
 * 整个请求只取一次 `now`：避免跨零点时同一批词落到不同日期。
 */
export async function updateWordsStatus({ userId, body, now = new Date() }) {
  const { ids, target, dryRun } = parseOrThrow(batchStatusSchema, body)

  // 同一个 id 传两次只算一次：目标只有一个，重复只会多写一次
  const uniqueIds = [...new Set(ids)]
  const validIds = uniqueIds.filter((id) => mongoose.isValidObjectId(id))
  const docs = await repo.findByIdsAndUser(validIds, userId)
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]))

  const skipped = []
  const changed = []
  let unchanged = 0

  // 按请求顺序遍历：skipped / words 的顺序要和用户勾选顺序一致
  for (const id of uniqueIds) {
    // 非法 id 与「查不到」对外是同一个结果，不泄露「存在但不属于你」
    if (!mongoose.isValidObjectId(id)) {
      skipped.push({ id, reason: 'NOT_FOUND' })
      continue
    }

    const doc = byId.get(id)
    if (!doc) {
      skipped.push({ id, reason: 'NOT_FOUND' })
      continue
    }

    const plan = planStatusTransition(doc, target, now)

    if (plan.action === 'skipped') {
      skipped.push({ id, word: doc.word, reason: plan.reason })
      continue
    }

    if (plan.action === 'unchanged') {
      unchanged += 1
      continue
    }

    changed.push({ id, doc, update: plan.update })
  }

  if (!dryRun && changed.length) {
    await repo.applyStatusBatch({
      userId,
      changes: changed.map(({ id, update }) => ({ id, update })),
    })

    // 与 removeBasicWord 同口径：移除时清掉基础词页的「认识」标记。
    // 否则以后物理删除墓碑时，残留标记会让它重新显示成「认识」。
    if (target === 'removed') {
      await markRepo.deleteByWords(
        userId,
        changed.map(({ doc }) => doc.word),
      )
    }
  }

  if (dryRun) {
    return {
      target,
      dryRun: true,
      requested: uniqueIds.length,
      updated: changed.length,
      unchanged,
      skipped,
      // 同时给 status 与 studyState：前端能提前提示
      // 「今天的新词改成 learning，今天仍显示在新词标签」
      plan: changed.map(({ id, doc, update }) => ({
        id,
        word: doc.word,
        action: 'changed',
        fromStatus: doc.status,
        toStatus: update.status ?? doc.status,
        fromStudyState: deriveStudyState(doc, now),
        toStudyState: deriveStudyState({ ...doc, ...update }, now),
      })),
    }
  }

  const written = changed.length
    ? await repo.findByIdsAndUser(
        changed.map(({ id }) => id),
        userId,
      )
    : []
  const writtenById = new Map(written.map((doc) => [String(doc._id), doc]))

  return {
    target,
    dryRun: false,
    requested: uniqueIds.length,
    updated: changed.length,
    unchanged,
    skipped,
    // 只回真正写入的词，顺序按请求 id；前端按 id 就地替换
    words: await withWordBanks(
      userId,
      changed
        .map(({ id }) => writtenById.get(id))
        .filter(Boolean)
        .map((doc) => toWordDto(doc, { now })),
    ),
    // 写后的最新五档计数，前端直接更新标签数字
    studyCounts: await buildStudyCounts(userId, now),
  }
}
