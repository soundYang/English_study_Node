import { startOfLocalDay } from '../../shared/utils/time.js'
import { firstReviewAt } from './review-schedule.js'
import { Word } from './word.model.js'

/**
 * 每日结算：把词推进到复习队列（md/56 §5）。
 *
 * **为什么要结算而不是定时任务**：
 * 服务器上没有任何 cron 框架，为这一个动作专门引入会带来三个麻烦——
 * 重启窗口内漏跑、多实例部署重复跑、还要单独处理时区。
 * 改成「读的时候顺手结算」，天然幂等：漏跑一次，下次请求自然补上；
 * 跑一百次，第二次起命中 0 条。
 *
 * **为什么挂在读路径**：`GET /api/words` 是用户每天打开的第一个词库接口，
 * 挂在这里等于「一打开就看到今天的队列」。生成入口也调一次，
 * 因为手机端可能直接从生成页进来，不经过词汇列表。
 *
 * @returns {Promise<{activated: number, scheduled: number}>} 本次实际改动的条数
 */
export async function settleDailyWords(userId, now = new Date()) {
  const today = startOfLocalDay(now)
  if (!today) return { activated: 0, scheduled: 0 }

  // ① 过夜的新词 → 复习中。
  //
  // 注意 `source: { $ne: 'basic-removed' }` 这一行不能删：
  // 用户在基础词页标「不认识」时，系统会写一条 `status:'new', source:'basic-removed'`
  // 的墓碑记录（basic-words.service.js）。它只是用来把词挡在基础词白名单外，
  // 用户从来没学过。不排除的话，标过的每一个「不认识」第二天都会涌进复习队列。
  //
  // 这里**不直接写 nextReviewAt**：交给 ② 按「加入时间的次日」统一排期，
  // 否则今天凌晨结算的词会全部堆在当天，与 ② 的规则不一致。
  const activated = await Word.updateMany(
    {
      userId,
      status: 'new',
      source: { $ne: 'basic-removed' },
      // $lt 当天零点：今天刚加的词今天不复习，第二天才进队列
      createdAt: { $lt: today },
    },
    { $set: { status: 'learning', reviewStage: 0 } },
  )

  // ② 补排期：复习中但还没有下次复习时间的词。
  //
  // 覆盖三类数据：本功能上线前就在库里的老词、用户今天刚加的词（排到明天）、
  // 以及任何异常中断留下的半截状态。有了这一条，不需要单独写迁移脚本。
  //
  // 用逐条 bulkWrite 而不是一条 updateMany：每条的到期日不同，
  // 要按各自的 lastReviewedAt / createdAt 算。条件里带上 `nextReviewAt: null`，
  // 并发结算时第二次自然命中 0 条。
  const unscheduled = await Word.find({
    userId,
    status: 'learning',
    nextReviewAt: null,
    source: { $ne: 'basic-removed' },
  })
    .select('_id lastReviewedAt createdAt')
    .lean()

  if (unscheduled.length === 0) {
    return { activated: activated.modifiedCount ?? 0, scheduled: 0 }
  }

  const result = await Word.bulkWrite(
    unscheduled.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id, nextReviewAt: null },
        update: { $set: { nextReviewAt: firstReviewAt(doc, now) } },
      },
    })),
    { ordered: false },
  )

  return {
    activated: activated.modifiedCount ?? 0,
    scheduled: result.modifiedCount ?? 0,
  }
}
