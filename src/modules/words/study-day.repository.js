import { StudyDay } from './study-day.model.js'

export const studyDayRepository = {
  /**
   * 给某一天的流水累加计数（md/56 §10 P3）。
   *
   * 用 `$inc` + `upsert` 而不是「读出来改再 save」：两个请求同时复习同一个词时，
   * 「读-改-写」会丢掉一次。`$inc` 在数据库侧原子累加。
   *
   * 并发 upsert 可能撞唯一索引报 11000：这说明另一个请求刚把文档建出来了，
   * 再执行一次不带 upsert 的更新即可，不是错误。
   */
  async bump({ userId, date, reviewed = 0, mastered = 0 }) {
    // 两个都是 0 时没有任何信息量，别为它建一条空文档把「这天有活动」记成真
    if (!reviewed && !mastered) return null

    try {
      return await StudyDay.updateOne(
        { userId, date },
        { $inc: { reviewed, mastered } },
        { upsert: true },
      )
    } catch (error) {
      if (error?.code !== 11000) throw error

      return StudyDay.updateOne({ userId, date }, { $inc: { reviewed, mastered } })
    }
  },

  /**
   * 取全部流水，按日期升序。
   *
   * 不分页：一个用户一年最多 365 条、十年 3650 条，
   * 一条只有三个字段，全量读进内存算连续天数比在数据库里递归便宜得多。
   */
  findAll(userId) {
    return StudyDay.find({ userId }).select('date reviewed mastered').sort({ date: 1 }).lean()
  },
}
