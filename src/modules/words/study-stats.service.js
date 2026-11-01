import { logger } from '../../shared/logger.js'
import { startOfLocalDay } from '../../shared/utils/time.js'
import { localDateKey } from './review-schedule.js'
import { studyDayRepository } from './study-day.repository.js'
import { wordRepository } from './word.repository.js'
import { settleDailyWords } from './word-settlement.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 热力图默认看多少天。30 天大约是一屏，再多前端也画不下 */
const HEATMAP_DAYS = 30

/**
 * 记一笔当天流水（md/56 §10 P3）。
 *
 * **绝不向上抛**：复习已经写进库了，因为「记流水」失败而回一个 500，
 * 用户会以为自己的自评没生效，然后再点一次——那才是真的出错。
 * 与 `markExposure` / `markReviewed` 的处理一致：统计失败只记日志。
 */
export async function recordStudyActivity({ userId, reviewed = 0, mastered = 0, at = new Date() }) {
  try {
    const date = localDateKey(at)
    if (!date) return

    await studyDayRepository.bump({ userId, date, reviewed, mastered })
  } catch (error) {
    logger.error({ err: error, userId }, 'study stats: recordActivity failed')
  }
}

/**
 * 连续复习天数。
 *
 * 今天还没复习**不算断**：从昨天往前数。
 * 否则用户每天早上打开首页都看到「连续 0 天」，昨天刚坚持过也白费。
 */
export function computeStreak(activeDates, now = new Date()) {
  const today = startOfLocalDay(now)
  if (!today) return 0

  const set = new Set(activeDates)
  const todayKey = localDateKey(today)

  let cursor = set.has(todayKey) ? today : new Date(today.getTime() - DAY_MS)
  let streak = 0

  // set 是有限的，日期不在里面就自然停下；不存在死循环
  while (set.has(localDateKey(cursor))) {
    streak += 1
    cursor = new Date(cursor.getTime() - DAY_MS)
  }

  return streak
}

/** 最近 N 天的连续日期键，含今天，升序 */
function recentDateKeys(now, days = HEATMAP_DAYS) {
  const today = startOfLocalDay(now)
  if (!today) return []

  return Array.from({ length: days }, (_, index) =>
    localDateKey(new Date(today.getTime() - (days - 1 - index) * DAY_MS)),
  )
}

/**
 * GET /api/words/stats（md/56 §10 P3）
 *
 * 三块：
 *   连续复习天数 —— 坚持感，首页红点旁边那行字
 *   今日 / 累计   —— 努力程度
 *   掌握情况      —— 已掌握词数 + 平均轮次（`MASTER_STAGE` 是 2，平均超过 2 说明老是没记住）
 *
 * 先结算再统计：不结算的话「待复习」会把昨天的新词漏掉，
 * 用户早上看到的红点数是昨天的。
 */
export async function getStudyStats({ userId, now = new Date() }) {
  await settleDailyWords(userId, now)

  const [days, pendingReview, mastery] = await Promise.all([
    studyDayRepository.findAll(userId),
    wordRepository.countDueForReview({ userId, now }),
    wordRepository.masterySummary(userId),
  ])

  const activeDates = days.filter((day) => day.reviewed > 0).map((day) => day.date)
  const todayKey = localDateKey(now)

  const today = days.find((day) => day.date === todayKey) ?? { reviewed: 0, mastered: 0 }

  const total = days.reduce(
    (sum, day) => ({
      reviewed: sum.reviewed + (day.reviewed ?? 0),
      mastered: sum.mastered + (day.mastered ?? 0),
    }),
    { reviewed: 0, mastered: 0 },
  )

  const byDate = new Map(days.map((day) => [day.date, day]))

  return {
    date: todayKey,
    streak: computeStreak(activeDates, now),
    today: { reviewed: today.reviewed ?? 0, mastered: today.mastered ?? 0 },
    total,
    mastery,
    // 首页红点：大于 0 才显示。它和 daily-plan 的 review.remaining 同源
    pendingReview,
    // 最近 30 天，缺的日子补 0——前端画热力图不该自己补空格子
    heatmap: recentDateKeys(now).map((date) => ({
      date,
      reviewed: byDate.get(date)?.reviewed ?? 0,
      mastered: byDate.get(date)?.mastered ?? 0,
    })),
  }
}
