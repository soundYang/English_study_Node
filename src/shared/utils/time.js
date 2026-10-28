/**
 * 时区相关的单点实现（方案 §12「时区」一条的落点）。
 *
 * 「今天新学 / 今天复习」按**服务器本地时区**判定，与用户所在时区一致。
 * 不能用 `toISOString().slice(0, 10)`：那是 UTC 日期，北京时间早上 8 点前
 * 建的新词会被算到前一天，用户点「今天新学」会发现刚加的词不见了。
 */

/** 某时刻所在「本地日」的零点；传入 null / 非法值时返回 null */
export function startOfLocalDay(value) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  date.setHours(0, 0, 0, 0)
  return date
}

/** 两个时刻是否落在同一个本地日；任一为空都算 false */
export function isSameLocalDay(a, b) {
  const left = startOfLocalDay(a)
  const right = startOfLocalDay(b)

  return Boolean(left && right && left.getTime() === right.getTime())
}

/** 两个时刻相差多少天（浮点）；任一为空返回 Infinity，便于当「很久以前」处理 */
export function daysSince(value, now = new Date()) {
  if (!value) return Number.POSITIVE_INFINITY

  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY

  return (now.getTime() - time) / 86_400_000
}
