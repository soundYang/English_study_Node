import { Word } from './word.model.js'

/**
 * 只和 Mongoose 打交道的一层。
 * 这里不出现业务判断（去重规则、降级规则都在 service 里）。
 */
export const wordRepository = {
  findPage({ filter, skip, limit }) {
    // createdAt 相同的情况下用 _id 兜底，保证分页顺序稳定
    return Word.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  },

  count(filter) {
    return Word.countDocuments(filter)
  },

  /** 按 status 分组计数；调用方保证只按 userId 匹配，不要带筛选条件 */
  countByStatus(userId) {
    return Word.aggregate([
      { $match: { userId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
  },

  findByIdAndUser(id, userId) {
    return Word.findOne({ _id: id, userId })
  },

  existsByWord(userId, word, excludeId) {
    const filter = { userId, word }
    if (excludeId) filter._id = { $ne: excludeId }

    return Word.exists(filter)
  },

  create(data) {
    return Word.create(data)
  },

  save(doc) {
    return doc.save()
  },

  deleteByIdAndUser(id, userId) {
    return Word.findOneAndDelete({ _id: id, userId })
  },
}
