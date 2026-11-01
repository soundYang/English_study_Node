/**
 * 词汇 DTO。白名单构造，不写字段删除逻辑——
 * 「删除法」在加字段时一定会漏，白名单法不会。
 */

const SUMMARY_MAX_LENGTH = 30
const SUMMARY_SENSE_COUNT = 2

/**
 * 列表页摘要：取前两条义项用「；」拼接，超过 30 字截断并追加省略号。
 * 与前端 mock 的 buildSummary 逐字一致（mock/adapter.js:134-141）。
 *
 * **只给列表用**（`English_vue/md/13` 第 6 条）：
 * 编辑表单请直接展示 `senses[]`。summary 是有损派生字段（截断 + 只取两条），
 * 拿它填表单会把丢弃的部分写丢，用户改完保存就真的少了内容。
 */
export function buildSummary(senses = []) {
  const text = (senses || [])
    .map((sense) => String(sense?.meaning ?? '').trim())
    .filter(Boolean)
    .slice(0, SUMMARY_SENSE_COUNT)
    .join('；')

  return text.length > SUMMARY_MAX_LENGTH
    ? `${text.slice(0, SUMMARY_MAX_LENGTH)}…`
    : text
}

/**
 * @param {object} doc Word 文档（lean 后的普通对象或 Mongoose 文档均可）
 */
export function toWordDto(doc) {
  const senses = (doc.senses || []).map((sense) => ({
    pos: sense.pos ?? '',
    meaning: sense.meaning,
  }))

  return {
    id: String(doc._id),
    word: doc.word,
    status: doc.status,
    createdAt: doc.createdAt,
    source: doc.source,
    dictionaryId: doc.dictionaryId ?? null,
    // COCA 排名：前端按它标「高频 / 中频 / 低频」（English_vue/md/13 C1）。
    // 手填词为 null，不是 0——0 会被当成「排名第 0」，null 才是「没有这个数」
    cocaRank: doc.cocaRank ?? null,
    // 手填词整体为 null；词库词的两项各自可能为 null
    phonetic: doc.phonetic
      ? { uk: doc.phonetic.uk ?? null, us: doc.phonetic.us ?? null }
      : null,
    senses,
    summary: buildSummary(senses),

    // ——— 复习调度（md/56）：前端据此显示「第 N 轮」与到期提示 ———
    // 老文档没有这几个字段，全部兜底，避免前端拿到 undefined 后渲染成 "undefined"
    reviewStage: doc.reviewStage ?? 0,
    nextReviewAt: doc.nextReviewAt ?? null,
    lapseCount: doc.lapseCount ?? 0,
    lastReviewedAt: doc.lastReviewedAt ?? null,
  }
}
