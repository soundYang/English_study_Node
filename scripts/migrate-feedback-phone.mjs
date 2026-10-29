#!/usr/bin/env node
/**
 * 反馈手机号快照清理（md/45 §10.4）。
 *
 * 从这一版起 `feedback` 不再存 `phone`：管理端显示时按 `userId` 关联 users 现查。
 * 但历史文档里还躺着提交当时的快照，不清掉的话「用户注销后库里仍留一份手机号」
 * 这件事依然成立——所以给一条显式的清理脚本。
 *
 * 用法：
 *   node scripts/migrate-feedback-phone.mjs        # dry-run，只统计
 *   node scripts/migrate-feedback-phone.mjs --yes  # 真的 $unset
 *
 * 先看一眼统计再决定：`用户已不存在` 的那些是最该清的（人已经注销），
 * `号码已变更` 的说明快照现在是错的，`仍然一致` 的清掉也不会丢信息（users 里还有）。
 *
 * 幂等：只处理 `phone` 存在的文档，重复执行不会多做任何事。
 *
 * 为什么走 `Feedback.collection` 而不是模型：schema 已经删掉了 `phone`，
 * Mongoose 的 strict 模式在读写两侧都会把这个字段吞掉——脚本要处理的恰恰是
 * 它看不见的那份历史数据。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { User } from '../src/modules/auth/user.model.js'

const hasFlag = (name) => process.argv.includes(`--${name}`)
const write = hasFlag('yes') && !hasFlag('dry-run')
const ANONYMOUS_DATA_KEY = 'anonymous'

async function main() {
  await mongoose.connect(config.mongodbUri)
  console.log(`connected: ${mongoose.connection.name}`)
  console.log(write ? '模式：写入' : '模式：dry-run（加 --yes 才会写入）')

  const collection = mongoose.connection.collection('feedbacks')
  const filter = { phone: { $exists: true, $nin: [null, ''] } }

  const total = await collection.countDocuments({})
  const withPhone = await collection.countDocuments(filter)
  console.log(`反馈总数 ${total}，带手机号快照 ${withPhone}`)

  if (withPhone === 0) {
    console.log('没有需要清理的文档')
    return
  }

  const docs = await collection.find(filter, { projection: { userId: 1, phone: 1 } }).toArray()
  const keys = [...new Set(docs.map((doc) => doc.userId))].filter(
    (key) => key && key !== ANONYMOUS_DATA_KEY,
  )
  const users = await User.find({ dataKey: { $in: keys } }).select('dataKey phone').lean()
  const phoneByKey = new Map(users.map((user) => [user.dataKey, user.phone ?? null]))

  const stats = { same: 0, changed: 0, missing: 0, anonymous: 0 }

  for (const doc of docs) {
    if (doc.userId === ANONYMOUS_DATA_KEY) {
      stats.anonymous += 1
      continue
    }

    if (!phoneByKey.has(doc.userId)) {
      stats.missing += 1
      continue
    }

    if (phoneByKey.get(doc.userId) === doc.phone) stats.same += 1
    else stats.changed += 1
  }

  console.log(`  用户仍存在且号码一致：${stats.same}（清掉不丢信息，users 里还能查到）`)
  console.log(`  用户存在但号码已变更：${stats.changed}（快照是错的，清掉正好）`)
  console.log(`  用户已不存在：${stats.missing}（人已注销，这份是残留 PII，应当清掉）`)
  console.log(`  未登录提交（anonymous）：${stats.anonymous}`)

  if (!write) {
    console.log('\ndry-run 结束，未修改任何数据。确认无误后加 --yes 重跑')
    return
  }

  const result = await collection.updateMany(filter, { $unset: { phone: '' } })
  console.log(`\n已清理 ${result.modifiedCount} 条文档的 phone 字段`)
  console.log(`复查：仍带 phone 的文档 ${await collection.countDocuments(filter)} 条`)
}

main()
  .catch((err) => {
    console.error('迁移失败：', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect()
  })
