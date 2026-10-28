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

  /** 生成文章用的可用词汇：只有 learning / mastered，new 不算 */
  countVocabulary(userId) {
    return Word.countDocuments({ userId, status: { $in: ['learning', 'mastered'] } })
  },

  /**
   * 选池用的候选词：只取 learning / mastered。
   *
   * 这里**不排序、不截断**。截断必须发生在「按复习优先级排完之后」
   * （vocabulary-pool.js）；在数据库层按 createdAt 倒序截断，丢掉的恰好是
   * 最早学的那批词，与「优先复习久未复习的词」完全相反。
   */
  findVocabulary(userId) {
    return Word.find({ userId, status: { $in: ['learning', 'mastered'] } })
      .select('word status cocaRank lastReviewedAt createdAt')
      .lean()
  },

  /**
   * 用户标记为 `new` 的词：个人基础词的减法项（md/06 §5.2）。
   *
   * 这些词既不在候选池里，也要从基础词白名单里扣掉——
   * 否则用户明明标了「不认识」，文章还是照用。
   */
  findNewWords(userId) {
    return Word.find({ userId, status: 'new' }).select('word').lean()
  },

  /**
   * 基础词页面用：一次取回这批词的个人记录。
   *
   * 走 `$in` 而不是 `find({ userId })` 全量拉：用户词库可能上万条，
   * 而页面只关心词表里这 650 个。只选三个字段——列表不展示个人记录里的快照，
   * 释义与音标一律以词库为准（见 basic-words.service 的 toItem）。
   */
  findByWords(userId, words) {
    if (!words.length) return Promise.resolve([])

    return Word.find({ userId, word: { $in: words } })
      .select('word status source')
      .lean()
  },

  findOneByWord(userId, word) {
    return Word.findOne({ userId, word })
  },

  deleteByWord(userId, word) {
    return Word.findOneAndDelete({ userId, word })
  },

  existsByWord(userId, word, excludeId) {
    const filter = { userId, word }
    if (excludeId) filter._id = { $ne: excludeId }

    return Word.exists(filter)
  },

  /**
   * 文章曝光：生成成功后记一次「这个词今天在正文里出现过」。
   *
   * 只写时间与次数，不改 status / lastReviewedAt——
   * 看了不等于复习了，真正算复习要等提交练习。
   */
  markExposure({ userId, words, at }) {
    if (!words.length) return Promise.resolve({ modifiedCount: 0 })

    return Word.updateMany(
      { userId, word: { $in: words } },
      { $set: { lastArticleExposureAt: at }, $inc: { articleExposureCount: 1 } },
    )
  },

  /**
   * 复习回写：提交练习时把这次练到的词标记为「已复习」。
   *
   * `vocabScope=today_reviewed` 完全依赖这个字段；不写它，
   * 用户「按今天复习的词生成文章」这条主链路永远是空池。
   */
  markReviewed({ userId, words, at }) {
    if (!words.length) return Promise.resolve({ modifiedCount: 0 })

    return Word.updateMany(
      { userId, word: { $in: words } },
      { $set: { lastReviewedAt: at } },
    )
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
