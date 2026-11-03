import { Word } from './word.model.js'

/**
 * 生成侧「用户已拥有的词」口径（md/60）。
 *
 * 包含 `learning` / `mastered`，以及用户自己添加、尚未开始复习的 `new`。
 * `new` 必须排除 `source: 'basic-removed'` 的墓碑：那是基础词页「不认识」的占位行，
 * 用户从来没有学过，不能进候选池，也不能算进词汇量。
 *
 * 这条查询是 `countVocabulary` 与 `findVocabulary` 的唯一口径，
 * 两处分开写迟早会分叉——一个说够、一个选不出词，正是 md/60 要修的缺陷。
 */
function generationVocabularyFilter(userId) {
  return {
    userId,
    status: { $in: ['learning', 'mastered', 'new'] },
    source: { $ne: 'basic-removed' },
  }
}

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

  /**
   * 按 status 分组计数；调用方保证只按 userId 匹配，不要带筛选条件。
   *
   * `includeRemoved=false` 时排除基础词墓碑（md/22 第 95 行 ③）：
   * 墓碑不是用户的词，把它算进「共 N 个词」会让词库页的数字对不上列表。
   */
  countByStatus(userId, { includeRemoved = false } = {}) {
    const match = { userId }
    if (!includeRemoved) match.source = { $ne: 'basic-removed' }

    return Word.aggregate([
      { $match: match },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
  },

  /**
   * 按 `studyState` 分档计数（md/22 第 95 行 ①）。
   *
   * 与 `WordDto.studyState` 的判定顺序一致：墓碑 → 已掌握 → 今天加的 → 其余。
   * 顺序错了会出现「墓碑被算进新词」「已掌握被算进复习中」这类对不上的数字。
   *
   * 分组在数据库里做：只回 3~4 行，比把整个词库拉进内存再数便宜得多。
   */
  countByStudyState(userId, today) {
    return Word.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: {
            removed: { $eq: ['$source', 'basic-removed'] },
            status: '$status',
            // createdAt 缺失时 $gte 为 false，落到「复习中」——与 deriveStudyState 的兜底一致
            today: { $gte: ['$createdAt', today] },
          },
          n: { $sum: 1 },
        },
      },
    ])
  },

  findByIdAndUser(id, userId) {
    return Word.findOne({ _id: id, userId })
  },

  /** 生成文章用的可用词汇：learning / mastered / 非墓碑 new（md/60） */
  countVocabulary(userId) {
    return Word.countDocuments(generationVocabularyFilter(userId))
  },

  /**
   * 选池用的候选词：learning / mastered / 非墓碑 new（md/60）。
   *
   * 这里**不排序、不截断**。截断必须发生在「按复习优先级排完之后」
   * （vocabulary-pool.js）；在数据库层按 createdAt 倒序截断，丢掉的恰好是
   * 最早学的那批词，与「优先复习久未复习的词」完全相反。
   */
  findVocabulary(userId) {
    return Word.find(generationVocabularyFilter(userId))
      // source 供 vocabScope 排除 basic-removed 墓碑，也供 md/60 的兜底提示
      .select('word status cocaRank lastReviewedAt createdAt source')
      .lean()
  },

  /**
   * 用户标了「不认识」的基础词：个人基础词的减法项（md/06 §5.2、md/56 §18）。
   *
   * 这些词既不在候选池里，也要从基础词白名单里扣掉——
   * 否则用户明明标了「不认识」，文章还是照用。
   *
   * **只认 `source: 'basic-removed'`**，不再按 `status: 'new'` 判断。
   * `new` 曾经同时表示「还没开始学」和「不认识」，一次机制调整后
   * 用户正常添加的词被留在了 `new` 上，于是加得越多、基础词池越小；
   * 收窄到墓碑之后，「不认识」只有这一个来源。
   */
  findRemovedBasicWords(userId) {
    return Word.find({ userId, source: 'basic-removed' }).select('word').lean()
  },

  /**
   * 基础词页面用：一次取回这批词的个人记录。
   *
   * 走 `$in` 而不是 `find({ userId })` 全量拉：用户词库可能上万条，
   * 而页面只关心词表里这 650 个。只选三个字段——列表不展示个人记录里的快照，
   * 释义与音标一律以词库为准（见 basic-words.service 的 toItem）。
   */
  findByWords(userId, words, select = 'word status source') {
    if (!words.length) return Promise.resolve([])

    const query = Word.find({ userId, word: { $in: words } })

    // 传 null 表示「全字段」：批量导入的合并判定要读 senses / phonetic / source
    return (select ? query.select(select) : query).lean()
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

  /**
   * 今天到期、还没复习的词（md/56 §5.4）。
   *
   * 按 `nextReviewAt` 升序：欠账最久的排前面，用户从列表头上开始复习
   * 就是他最该补的那批。同一时刻到期的用 `_id` 兜底，保证分页顺序稳定。
   */
  findDueForReview({ userId, now, limit }) {
    const query = Word.find({ userId, status: 'learning', nextReviewAt: { $lte: now } })
      .sort({ nextReviewAt: 1, _id: 1 })

    if (limit) query.limit(limit)

    return query.lean()
  },

  countDueForReview({ userId, now }) {
    return Word.countDocuments({ userId, status: 'learning', nextReviewAt: { $lte: now } })
  },

  /**
   * 已掌握词的规模与平均轮次（md/56 §10 P3）。
   *
   * `MASTER_STAGE` 是 2，平均轮次明显高于 2 说明用户老是「没记住」、
   * 反复回到起点——这正是复习曲线该被调参的信号。
   * 没有已掌握词时返回 0 而不是 NaN：`$avg` 对空集合返回 null。
   */
  async masterySummary(userId) {
    const [row] = await Word.aggregate([
      { $match: { userId, status: 'mastered' } },
      { $group: { _id: null, count: { $sum: 1 }, avgStage: { $avg: '$reviewStage' } } },
    ])

    if (!row) return { count: 0, avgStage: 0 }

    return {
      count: row.count,
      // 保留一位小数：1.4 比 1.3913043478260869 好读，也够用
      avgStage: Math.round((row.avgStage ?? 0) * 10) / 10,
    }
  },

  /** 今天已经复习过的词数（交过卷、且那次交卷落在今天） */
  countReviewedBetween({ userId, from, to }) {
    return Word.countDocuments({ userId, lastReviewedAt: { $gte: from, $lt: to } })
  },

  /** 今天新加的词数；`source: basic-removed` 的墓碑不算「学了一个新词」 */
  countCreatedBetween({ userId, from, to }) {
    return Word.countDocuments({
      userId,
      source: { $ne: 'basic-removed' },
      createdAt: { $gte: from, $lt: to },
    })
  },

  /**
   * 自评「通过」：推进一轮，排下次复习（md/56 §6.2）。
   *
   * 用 `updateOne` 而不是读出来改再 save：自评是幂等动作，
   * 用户连点两次不该把轮次推两轮。调用方先读一遍拿当前 stage，
   * 这里只按算好的结果写。
   */
  applyReviewPass({ userId, word, stage, nextReviewAt, at }) {
    return Word.updateOne(
      { userId, word },
      {
        $set: {
          status: 'learning',
          reviewStage: stage,
          nextReviewAt,
          lastResult: 'pass',
          lastReviewedAt: at,
        },
      },
    )
  },

  /** 自评「通过」且已达掌握线：转 mastered，退出复习队列 */
  applyMastery({ userId, word, stage, at }) {
    return Word.updateOne(
      { userId, word },
      {
        $set: {
          status: 'mastered',
          reviewStage: stage,
          nextReviewAt: null,
          lastResult: 'pass',
          lastReviewedAt: at,
          masteredAt: at,
        },
      },
    )
  },

  /** 自评「没记住」：轮次归零、明天再来 */
  applyLapse({ userId, word, nextReviewAt, at }) {
    return Word.updateOne(
      { userId, word },
      {
        $set: {
          status: 'learning',
          reviewStage: 0,
          nextReviewAt,
          lastResult: 'lapse',
          lastReviewedAt: at,
        },
        $inc: { lapseCount: 1 },
      },
    )
  },

  /**
   * 批量推进复习轮次：交卷回写（md/56 §6.2）与批量自评（§8.1）共用。
   *
   * 三种结果按写回内容区分，不在调用方重复一遍「怎么写」：
   *   lapse: true           没记住 —— 轮次归零、计数 +1、按传入的时间再来
   *   nextReviewAt === null 已达掌握线 —— 转 mastered，退出队列
   *   其余                  通过一轮 —— 记轮次与下次复习时间
   *
   * 过滤条件里带 `source: { $ne: 'basic-removed' }`：即使调用方漏判，
   * 基础词墓碑也不会被复活（同 `settleDailyWords` 的原因）。
   *
   * `ordered: false`：一篇文章的十几个 focus/target 互不依赖，
   * 其中一条写失败不应该拦住其它词。
   *
   * @param {Array<{word: string, stage: number, nextReviewAt: Date|null, lapse?: boolean}>} updates
   */
  applyReviewBatch({ userId, updates, at }) {
    if (!updates.length) return Promise.resolve({ modifiedCount: 0 })

    return Word.bulkWrite(
      updates.map((item) => ({
        updateOne: {
          filter: { userId, word: item.word, source: { $ne: 'basic-removed' } },
          update: item.lapse
            ? {
                $set: {
                  status: 'learning',
                  reviewStage: 0,
                  nextReviewAt: item.nextReviewAt,
                  lastResult: 'lapse',
                  lastReviewedAt: at,
                },
                $inc: { lapseCount: 1 },
              }
            : item.nextReviewAt === null
              ? {
                  $set: {
                    status: 'mastered',
                    reviewStage: item.stage,
                    nextReviewAt: null,
                    lastResult: 'pass',
                    lastReviewedAt: at,
                    masteredAt: at,
                  },
                }
              : {
                  $set: {
                    status: 'learning',
                    reviewStage: item.stage,
                    nextReviewAt: item.nextReviewAt,
                    lastResult: 'pass',
                    lastReviewedAt: at,
                  },
                },
        },
      })),
      { ordered: false },
    )
  },

  /**
   * 批量改状态（md/61）。
   *
   * 与批量自评一样用 `ordered:false`：一条写失败不拦住后面所有条。
   * 这里只写 service 算好的 `$set`，不在这里做任何状态判断——
   * 迁移矩阵在 `word-status.js`，单条 PATCH 与批量共用。
   */
  applyStatusBatch({ userId, changes }) {
    if (!changes.length) return Promise.resolve({ modifiedCount: 0 })

    return Word.bulkWrite(
      changes.map(({ id, update }) => ({
        updateOne: {
          filter: { _id: id, userId },
          update: { $set: update },
        },
      })),
      { ordered: false },
    )
  },

  /**
   * 按 id 批量取词，供批量自评用（md/56 §8.1）。
   *
   * 非法 id 在 service 层已被过滤，这里不做 `isValidObjectId` 判断——
   * 混进一个非法值会让整个 `$in` 抛 CastError，一条坏数据拖垮一批正常请求。
   */
  findByIdsAndUser(ids, userId, select) {
    if (!ids.length) return Promise.resolve([])

    const query = Word.find({ _id: { $in: ids }, userId })

    return (select ? query.select(select) : query).lean()
  },

  create(data) {
    return Word.create(data)
  },

  /**
   * 批量新建成（md/44 §5.4）。`ordered: false` 让一条失败不拦住后面所有条，
   * 重复由唯一索引报 11000，调用方再按合并策略兜一次。
   */
  insertMany(docs) {
    return Word.insertMany(docs, { ordered: false })
  },

  /** 批量合并已有词：一次 bulkWrite 代替 N 次 save */
  bulkUpdate(operations) {
    return Word.bulkWrite(operations)
  },

  save(doc) {
    return doc.save()
  },

  deleteByIdAndUser(id, userId) {
    return Word.findOneAndDelete({ _id: id, userId })
  },
}
