#!/usr/bin/env node
/**
 * 把「新词」状态的用户词条迁到「复习中」（md/56 §18）。
 *
 * 背景：`status: 'new'` 曾经同时表示两件事——
 *   1. 基础词页标「不认识」留下的墓碑（`source: 'basic-removed'`）；
 *   2. 用户还没开始学的词。
 * 机制调整后，用户正常添加的词也被留在了 `new` 上。它们会被
 * `findRemovedBasicWords` 之外的旧逻辑当成「不认识」，既不进候选池、
 * 也不计入 knownWords，于是「加得越多，能写的文章越少」。
 *
 * 现在把第 2 类迁成 `status: 'learning'`（复习中）：
 *   · 墓碑（`source: 'basic-removed'`）**一律不动**——那就是「不认识」，不是没学；
 *   · `nextReviewAt` 置 null，交给下一次读词库时的 `settleDailyWords` 按
 *     `firstReviewAt`（加入时间的次日）统一排期，不在这里另造一套规则；
 *   · `reviewStage` 归零：这些词从没复习过。
 *
 * 用法：
 *   node scripts/migrate-new-words-to-learning.mjs            # dry-run，只打印
 *   node scripts/migrate-new-words-to-learning.mjs --yes      # 真的写入
 *
 * 幂等：条件是 `status: 'new'` + 非墓碑，跑第二遍命中 0 条。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Word } from '../src/modules/words/word.model.js'

const hasFlag = (name) => process.argv.includes(`--${name}`)
const write = hasFlag('yes') && !hasFlag('dry-run')

const FILTER = { status: 'new', source: { $ne: 'basic-removed' } }

async function main() {
  await mongoose.connect(config.mongodbUri)
  console.log(`connected: ${mongoose.connection.name}`)
  console.log(write ? '模式：写入' : '模式：dry-run（加 --yes 才会写入）')

  const rows = await Word.find(FILTER).select('userId word createdAt').lean()

  const byUser = new Map()
  for (const row of rows) {
    byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + 1)
  }

  console.log(`待迁移：${rows.length} 条 / ${byUser.size} 个用户`)
  for (const [userId, count] of byUser) {
    console.log(`  ${userId}: ${count} 条`)
  }

  if (rows.length) {
    const sample = rows.slice(0, 10).map((row) => row.word).join(', ')
    console.log(`  示例：${sample}${rows.length > 10 ? ' …' : ''}`)
  }

  const tombs = await Word.countDocuments({ userId: { $in: [...byUser.keys()] }, source: 'basic-removed' })
  console.log(`同一批用户下的墓碑（不动）：${tombs} 条`)

  if (!write) {
    console.log('\n当前是 dry-run，没有写入。确认无误后加 --yes 执行。')
    return
  }

  const result = await Word.updateMany(FILTER, {
    $set: { status: 'learning', reviewStage: 0, nextReviewAt: null },
  })

  console.log(`\n已迁移：${result.modifiedCount} 条`)
  console.log('下次读取词库时 settleDailyWords 会按加入日排期（老词会直接进今日复习队列）。')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
