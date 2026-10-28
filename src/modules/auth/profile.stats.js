import { Reading } from '../readings/reading.model.js'

/**
 * 个人中心统计（md/33 §9）。
 *
 * 三个口径都在方案里定过，改动前先回去看：
 *   准确率 = 总答对题数 / 总题数（**不是**各篇得分的平均）
 *   token  = 所有阅读的 aiMeta.totalTokens 之和，含未提交的——钱花在生成上
 *   柱状图 = 近 12 周、每周一为起点、无数据的周补 0
 */

const WEEKLY_BUCKETS = 12

/** 周一为一周起点，0 点对齐；与前端 mock 的 startOfWeek 同口径 */
export function startOfWeek(value) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  // getDay() 周日是 0，换算成「周一 = 0」的偏移
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return date
}

/** 本地时区的 YYYY-MM-DD；不用 toISOString，那会把东八区的周一变成周日 */
function formatLocalDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * @param {{ userId: string, now?: Date }} payload
 *   userId 是 **dataKey**（业务数据的归属），不是 users._id
 */
export async function getProfileStats({ userId, now = new Date() }) {
  const [row] = await Reading.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: null,
        generatedCount: { $sum: 1 },
        totalTokens: { $sum: { $ifNull: ['$aiMeta.totalTokens', 0] } },
        submittedCount: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
        // 分母用真实题目数组长度，不是 questionCount：模型少给一题时两者会差 1
        answered: {
          $sum: {
            $cond: [
              { $eq: ['$status', 'submitted'] },
              { $size: { $ifNull: ['$questions', []] } },
              0,
            ],
          },
        },
        correct: {
          $sum: {
            $cond: [{ $eq: ['$status', 'submitted'] }, { $ifNull: ['$correctCount', 0] }, 0],
          },
        },
      },
    },
  ])

  const stats = row ?? {
    generatedCount: 0,
    totalTokens: 0,
    submittedCount: 0,
    answered: 0,
    correct: 0,
  }

  const accuracy = stats.answered > 0 ? Math.round((stats.correct / stats.answered) * 100) : 0

  // ——— 近 12 周（含本周），无数据的周补 0 ———
  // 只投影两个时间字段取回后在 JS 里分桶：个人数据量小，
  // 比依赖 $dateTrunc（MongoDB 5.0+）更稳，也不会因内存 Mongo 版本不同而静默出错
  const currentWeek = startOfWeek(now)
  const firstWeek = new Date(currentWeek)
  firstWeek.setDate(firstWeek.getDate() - (WEEKLY_BUCKETS - 1) * 7)

  const weekly = []
  for (let index = 0; index < WEEKLY_BUCKETS; index += 1) {
    const start = new Date(firstWeek)
    start.setDate(start.getDate() + index * 7)
    weekly.push({ time: start.getTime(), weekStart: formatLocalDate(start), count: 0 })
  }

  const rows = await Reading.find({
    userId,
    status: 'submitted',
    // 老文档可能没有 submittedAt，退回 createdAt（与前端 mock 的 `submittedAt || createdAt` 一致）
    $or: [
      { submittedAt: { $gte: firstWeek } },
      { submittedAt: null, createdAt: { $gte: firstWeek } },
    ],
  })
    .select('submittedAt createdAt')
    .lean()

  const byWeek = new Map(weekly.map((bucket) => [bucket.time, bucket]))
  for (const item of rows) {
    const week = startOfWeek(item.submittedAt ?? item.createdAt)
    const bucket = byWeek.get(week.getTime())
    // 13 周前的老篇目不会被查出来，这里再判一次是因为查询用的是 submittedAt、分桶可能落在窗口外
    if (bucket) bucket.count += 1
  }

  return {
    reading: {
      completedCount: stats.submittedCount,
      generatedCount: stats.generatedCount,
      totalTokens: stats.totalTokens,
    },
    questions: {
      answered: stats.answered,
      correct: stats.correct,
      wrong: stats.answered - stats.correct,
      accuracy,
    },
    weekly: weekly.map(({ weekStart, count }) => ({ weekStart, count })),
  }
}
