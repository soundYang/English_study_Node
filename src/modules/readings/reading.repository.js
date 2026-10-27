import { Reading } from './reading.model.js'

/** 只和 Mongoose 打交道，业务规则在 service 里 */
export const readingRepository = {
  create(data) {
    return Reading.create(data)
  },

  findByIdAndUser(id, userId) {
    return Reading.findOne({ _id: id, userId })
  },

  existsByIdAndUser(id, userId) {
    return Reading.exists({ _id: id, userId })
  },

  /**
   * 条件更新：只有仍是 generated 的才能改成 submitted。
   * 并发的两个提交里只有一个能命中，另一个拿到 null——
   * 「先查再改」做不到这一点。
   */
  submitIfGenerated(id, userId, data) {
    return Reading.findOneAndUpdate(
      { _id: id, userId, status: 'generated' },
      { $set: data },
      { new: true },
    )
  },

  findHistoryPage({ userId, level, skip, limit }) {
    const filter = { userId }
    if (level !== 'all') filter.level = level

    // createdAt 相同用 _id 兜底，保证翻页顺序稳定
    return Reading.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  },

  countHistory({ userId, level }) {
    const filter = { userId }
    if (level !== 'all') filter.level = level

    return Reading.countDocuments(filter)
  },

  /** 统计口径固定为「全部已提交」，与 level 筛选无关，调用方不要传筛选条件 */
  statsByUser(userId) {
    return Reading.aggregate([
      { $match: { userId, status: 'submitted' } },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          scoreSum: { $sum: '$score' },
          bestScore: { $max: '$score' },
          totalWordsRead: { $sum: '$actualWords' },
        },
      },
    ])
  },
}
