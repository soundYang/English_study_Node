import { WordBankMembership } from './word-bank-membership.model.js'

/**
 * 词库导入记录的读写层。
 *
 * 所有方法都按 userId 收窄，跨用户数据不会串。
 */
export const wordBankMembershipRepository = {
  /** 当前页词的导入记录：一次 $in，不逐行查 */
  findByWords(userId, words) {
    if (!words.length) return Promise.resolve([])
    return WordBankMembership.find({ userId, word: { $in: words } }).lean()
  },

  /** 某个词库的全部导入记录；用于列表筛选、概要与重置 */
  findWordsByBank(userId, bank) {
    return WordBankMembership.find({ userId, bank })
      .select('word importedAt')
      .lean()
  },

  countByBank(userId, bank) {
    return WordBankMembership.countDocuments({ userId, bank })
  },

  /** 某个词库下、指定词形的导入记录；用于批量改状态前校验 */
  findByBankAndWords(userId, bank, words) {
    if (!words.length) return Promise.resolve([])
    return WordBankMembership.find({ userId, bank, word: { $in: words } }).lean()
  },

  /** 这些词是否还从其它词库导入；重置时用于保护 Word 不被误删 */
  findOtherBanksByWords(userId, bank, words) {
    if (!words.length) return Promise.resolve([])
    return WordBankMembership.find({
      userId,
      bank: { $ne: bank },
      word: { $in: words },
    })
      .select('word')
      .lean()
  },

  /**
   * 批量 upsert。
   * `$setOnInsert` 保证 importedAt / addedBy 不被重复导入覆盖。
   */
  upsertMany(userId, entries) {
    if (!entries.length) return Promise.resolve()

    return WordBankMembership.bulkWrite(
      entries.map(({ word, bank, importedAt, addedBy }) => ({
        updateOne: {
          filter: { userId, word, bank },
          update: {
            $setOnInsert: { userId, word, bank, importedAt, addedBy },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    )
  },

  /** 用户手动删除某个词时，清理它的导入记录 */
  deleteByWord(userId, word) {
    return WordBankMembership.deleteMany({ userId, word })
  },

  /** 重置整个词库时，删除该词库的全部导入记录 */
  deleteByBank(userId, bank) {
    return WordBankMembership.deleteMany({ userId, bank })
  },
}
