import { BasicWordMark } from './basic-word-mark.model.js'

/**
 * 「认识」标记的读写（md/52）。只和 Mongoose 打交道，业务判定在 service。
 *
 * 全部按 `userId + word` 操作：词表是静态的，同一个词对同一个用户只有一条记录。
 */
export const basicWordMarkRepository = {
  /** 这一页要展示的词里，哪些被标成了认识；返回 Set，避免调用方再包一层 */
  async findWords(userId, words) {
    if (!words.length) return new Set()

    const docs = await BasicWordMark.find({ userId, word: { $in: words } })
      .select('word')
      .lean()

    return new Set(docs.map((doc) => doc.word))
  },

  /**
   * 标记认识。幂等：已经标过再标一次不报错。
   *
   * 用 upsert 而不是「先查再插」：唯一索引兜底并发，
   * 两个请求同时进来也只会留下一条。
   */
  async add(userId, word) {
    try {
      await BasicWordMark.updateOne(
        { userId, word },
        { $setOnInsert: { userId, word } },
        { upsert: true },
      )
    } catch (err) {
      // 并发 upsert 撞唯一索引：说明另一个请求刚写进去了，结果一致
      if (err?.code !== 11000) throw err
    }
  },

  deleteByWord(userId, word) {
    return BasicWordMark.deleteOne({ userId, word })
  },

  /**
   * 批量清标记（md/61）：批量移除时与 `removeBasicWord` 同口径。
   *
   * 只写 `source` 不清标记，词被物理删除后残留标记会让它在基础词页
   * 重新显示成「认识」，所以移除成功后必须一起清掉。
   */
  deleteByWords(userId, words) {
    if (!words.length) return Promise.resolve({ deletedCount: 0 })
    return BasicWordMark.deleteMany({ userId, word: { $in: words } })
  },
}
