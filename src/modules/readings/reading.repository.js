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
}
