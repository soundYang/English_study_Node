import { startOfLocalDay } from '../../shared/utils/time.js'

/**
 * 复习节奏的常量与纯函数（方案见 `md/56_单词学习与复习生命周期_方案.md`）。
 *
 * **为什么不放进 `src/config`**：`md/06` §11 已经定过口径——选池比例这类「算法参数」
 * 就地导出（`vocabulary-pool.js` 的 `POOL_RATIOS` / `REVIEW_STALE_DAYS`），不走 env。
 * 它们不是部署差异，是产品规则；放进 env 会让同一套回归用例在不同机器上跑出不同结果。
 */

/** 每日新词配额。只用于前端显示进度，**不拦截**——拦截会在冷启动阶段劝退用户 */
export const DAILY_NEW_WORDS = 10

/**
 * 通过几轮算「已掌握」。
 *
 * 2 = 次日一次 + 3 天后一次，约 4 天走完（方案 §3.2 的默认档）。
 * 改成 1 就是「次日一次通过即掌握」，最接近最初的设想，但可信度低一些。
 */
export const MASTER_STAGE = 2

/**
 * 每次「通过」之后隔几天再复习。
 *
 * 长度必须等于 `MASTER_STAGE - 1`：第一次复习固定是**次日**，由结算函数直接排，
 * 不在这个数组里。改 `MASTER_STAGE` 时记得同步改这个数组的长度，
 * 多给的元素会被忽略、少给会退化成 1 天（`nextReviewAtAfterPass` 的兜底）。
 */
export const REVIEW_INTERVALS_DAYS = [3]

/**
 * 每日复习上限：一天最多从积压里捞多少个词进「今日清单」。
 *
 * 不是硬拦截，只是**排序上的截断**——超出的词仍然逾期，明天还在队列里。
 * 没有这个上限，功能上线的第一天会把用户整个词库（可能上千个）
 * 一次性倒进复习清单，比不做还吓人。
 */
export const DAILY_REVIEW_LIMIT = 50

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 一个从没排过期的词，第一次该什么时候复习：**上次复习（没有就用加入时间）的次日**。
 *
 * 为什么不是「一律排到今天」：用户词库里往往有上千个从没复习过的老词，
 * 一律排今天等于上线当天给他一个 1000 条的待办。
 * 按各自的加入 / 复习时间排，逾期多少就是多少，至少时间轴是真实的。
 *
 * @param {object} doc 至少要带 createdAt，可选 lastReviewedAt
 */
export function firstReviewAt(doc, now = new Date()) {
  const base = doc?.lastReviewedAt ?? doc?.createdAt
  const day = startOfLocalDay(base)

  // 时间缺失或脏数据：退回「今天到期」，让它至少能被用户看见
  if (!day) return startOfLocalDay(now)

  return new Date(day.getTime() + DAY_MS)
}

/**
 * 通过第 `stage` 轮之后，下次什么时候复习。
 *
 * 这里用「毫秒加法」而不是 `setDate(+3)`：东八区没有夏令时，
 * 两种写法等价；但毫秒加法在测试里可以直接传假时间断言，不依赖运行环境的时区。
 *
 * @param {number} stage 通过之后的新轮次（1 起步）
 * @returns {Date|null} 已到掌握线返回 null
 */
export function nextReviewAtAfterPass(stage, now = new Date()) {
  if (stage >= MASTER_STAGE) return null

  const days = REVIEW_INTERVALS_DAYS[stage - 1] ?? 1

  return new Date(now.getTime() + days * DAY_MS)
}

/**
 * 判「没记住」之后，下次什么时候复习：明天的零点。
 *
 * 用零点而不是「现在 + 24 小时」：晚上 23:50 点的「没记住」，
 * 加法会把它排到明天 23:50，用户第二天白天根本看不到这个词。
 */
export function nextReviewAtAfterLapse(now = new Date()) {
  const today = startOfLocalDay(now)

  return today ? new Date(today.getTime() + DAY_MS) : null
}

/** 该词的复习是否已到期 */
export function isDue(nextReviewAt, now = new Date()) {
  if (!nextReviewAt) return false

  const at = new Date(nextReviewAt)

  return !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime()
}

/**
 * 本地日期的 `YYYY-MM-DD` 形式，用作「今日任务」的键。
 *
 * 不能用 `toISOString().slice(0, 10)`：那是 UTC 日期，
 * 北京时间早上 8 点前会算成前一天（`shared/utils/time.js` 开头有同样的说明）。
 */
export function localDateKey(value = new Date()) {
  const date = startOfLocalDay(value)
  if (!date) return null

  const pad = (n) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
