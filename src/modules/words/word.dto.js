/**
 * 词汇 DTO。白名单构造，不写字段删除逻辑——
 * 「删除法」在加字段时一定会漏，白名单法不会。
 */

import { startOfLocalDay } from '../../shared/utils/time.js'

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
 * 词的学习阶段（md/56 §14.4 的方案 B）。
 *
 * **不是**直接暴露 `status`：`status` 是数据库口径（`new` 还是基础词的减法标记），
 * 它跟用户看到的「新词 / 复习中 / 已掌握」并不是一一对应的。
 * 这里由后端把两件事算成一个字段，前端只做中文映射，不再自己判断日期。
 *
 *   removed   基础词表里标了「不认识」，不是用户的词，不进队列也不进选池
 *   mastered  已掌握
 *   new       今天加入的，还没过夜 —— 对应「新词」
 *   reviewing 其余（含结算前的 learning 和结算后会变 learning 的新词）—— 对应「复习中」
 *
 * 判「今天」用本地零点而不是 24 小时差：用户晚上 23:00 加的词
 * 第二天早上就该是「复习中」，不能等到第二天 23:00。
 *
 * @param {object} doc  至少要带 status / source / createdAt
 * @param {Date}   now  注入时间便于测试
 */
export function deriveStudyState(doc, now = new Date()) {
  if (doc?.source === 'basic-removed') return 'removed'
  if (doc?.status === 'mastered') return 'mastered'

  const today = startOfLocalDay(now)
  const created = startOfLocalDay(doc?.createdAt)

  // 时间缺失或脏数据：按「老词」处理，宁可显示「复习中」也不要凭空多出一个「新词」
  if (!today || !created) return 'reviewing'

  return created.getTime() >= today.getTime() ? 'new' : 'reviewing'
}

/**
 * @param {object} doc Word 文档（lean 后的普通对象或 Mongoose 文档均可）
 * @param {object} [options] `{ now }` 注入「今天」，仅测试用
 */
export function toWordDto(doc, { now = new Date() } = {}) {
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
    // 由词库导入的标签；service 层查导入记录后覆盖。旧客户端忽略即可
    wordBanks: [],
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

    // ——— 学习阶段（md/56 §14.4 方案 B）：前端只做中文映射，不做日期判断 ———
    // 「新词」= 今天加入的；次日结算后自动变 reviewing，前端无需任何额外逻辑
    studyState: deriveStudyState(doc, now),

    // ——— 复习调度（md/56）：前端据此显示「第 N 轮」与到期提示 ———
    // 老文档没有这几个字段，全部兜底，避免前端拿到 undefined 后渲染成 "undefined"
    reviewStage: doc.reviewStage ?? 0,
    nextReviewAt: doc.nextReviewAt ?? null,
    lapseCount: doc.lapseCount ?? 0,
    lastReviewedAt: doc.lastReviewedAt ?? null,
  }
}
