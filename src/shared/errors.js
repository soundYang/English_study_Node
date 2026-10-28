/**
 * 错误体系：所有"能明确告诉用户哪里错了"的情况都走 ApiError，
 * 只有真正没预料到的异常才由 errorHandler 兜成 500。
 */

/** 业务异常：带 HTTP 状态码和错误码，errorHandler 会原样返回给前端 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code 错误码，取值见 ERROR_CODES
   * @param {string} message 给用户看的中文提示
   * @param {string} [field] 出错的表单字段名，前端据此把错误挂在对应输入框下
   * @param {object|null} [details] 结构化补充信息（如 422 的 required / available），
   *   由 errorHandler 原样透出。只在需要前端做计算或分支时使用
   */
  constructor(status, code, message, field = '', details = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
    this.details = details
  }
}

/**
 * 全部业务错误码（《后端接口说明》§4.7）。
 * 前端按 code 分支，不能改成别的值——尤其是 READING_NOT_FOUND
 * （渲染 404 错误卡）和 ALREADY_SUBMITTED（自动拉结果并跳转）。
 */
export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_QUERY: 'INVALID_QUERY',
  INVALID_ANSWER: 'INVALID_ANSWER',
  READONLY_FIELD: 'READONLY_FIELD',
  DICTIONARY_ENTRY_NOT_FOUND: 'DICTIONARY_ENTRY_NOT_FOUND',
  WORD_NOT_FOUND: 'WORD_NOT_FOUND',
  READING_NOT_FOUND: 'READING_NOT_FOUND',
  WORD_EXISTS: 'WORD_EXISTS',
  ALREADY_SUBMITTED: 'ALREADY_SUBMITTED',
  INSUFFICIENT_VOCABULARY: 'INSUFFICIENT_VOCABULARY',
  VOCABULARY_TOO_SMALL: 'VOCABULARY_TOO_SMALL',
  VOCABULARY_VALIDATION_FAILED: 'VOCABULARY_VALIDATION_FAILED',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  AI_INVALID_RESPONSE: 'AI_INVALID_RESPONSE',
  // 分段路径丢段过多（md/23 D2 / md/27 §3）：结构是对的，但成文残缺。
  // 与 AI_INVALID_RESPONSE 分开，前端才能给「换短一点的篇幅再试」这类文案。
  ARTICLE_TOO_INCOMPLETE: 'ARTICLE_TOO_INCOMPLETE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
})

/** 400：参数校验失败，带上 field 前端就能把错误显示在字段下方 */
export const badRequest = (message, field) =>
  new ApiError(400, ERROR_CODES.INVALID_REQUEST, message, field)

/**
 * 404 的 code 必须显式传：
 * 前端按 code 区分「404 错误卡」和普通 Toast，不能统一给 NOT_FOUND。
 */
export const notFound = (code, message) => new ApiError(404, code, message)

/** 409：状态冲突，例如单词重复、重复提交 */
export const conflict = (code, message, field) =>
  new ApiError(409, code, message, field)

// 常用快捷方式，避免调用点漏写 code
export const wordNotFound = () =>
  notFound(ERROR_CODES.WORD_NOT_FOUND, '单词不存在')

export const readingNotFound = () =>
  notFound(ERROR_CODES.READING_NOT_FOUND, '练习不存在')

/**
 * 难度英文枚举 → 中文。不要把 easy/hard 直接塞进给用户看的提示语。
 *
 * 用「进阶 / 挑战」而不是「中等 / 困难」，是为了和界面按钮的叫法一致
 * （English_vue/md/13 第 5 条）：同一难度出现两个名字，读起来像两件事。
 */
const LEVEL_LABELS = Object.freeze({ easy: '简单', medium: '进阶', hard: '挑战' })

/**
 * 422：候选池装不下这次篇幅所需的目标词，禁止生成（方案 §6.2）。
 *
 * 提示语把四层数字都写出来——目标词数、折算后的已学词数、现有词数、差额——
 * 用户才知道该加词、缩篇幅还是降难度。`details` 同时给结构化版本，
 * 前端要显示进度条或算差值时不必自己再推一遍。
 *
 * @param {{
 *   required: number,       // 折算后的已学词门槛（neededVocab）
 *   available: number,      // 当前候选池实际词数
 *   requiredWords: number,  // 篇幅换算出的目标词数
 *   targetWords: number,    // 用户请求的篇幅
 *   scope: string[],
 *   level: string,
 * }} payload
 */
export const vocabularyTooSmall = ({
  required,
  available,
  requiredWords,
  targetWords,
  scope,
  level,
}) =>
  new ApiError(
    422,
    ERROR_CODES.VOCABULARY_TOO_SMALL,
    `${LEVEL_LABELS[level] ?? level}模式写 ${targetWords} 词的文章需要约 ${requiredWords} 个目标词，`
      + `折算下来至少要有 ${required} 个已学单词，当前符合条件的只有 ${available} 个`
      + `（还差 ${Math.max(0, required - available)} 个）。`
      + '请添加更多单词，或缩短篇幅、降低难度。',
    'targetWords',
    // kind 让前端区分两道 422：目标词凑不齐（缩篇幅/降难度）与已知词汇量不够（加词）
    { kind: 'target_words', required, available, requiredWords, targetWords, scope, level },
  )

/**
 * 400：该难度不支持这么长的请求（md/20 §2.2 篇幅上限跟难度走）。
 *
 * 与 422 分开：这不是「你词不够」，而是「这个组合不存在」。
 * 滑块上限应当直接读 /capacity 的 maxTargetWords，正常前端走不到这里。
 */
export const targetWordsTooLong = ({ level, targetWords, maxTargetWords }) =>
  new ApiError(
    400,
    ERROR_CODES.INVALID_REQUEST,
    `${LEVEL_LABELS[level] ?? level}模式最高支持 ${maxTargetWords} 词（本次请求 ${targetWords} 词）。`
      + '请缩短篇幅，或提高难度。',
    'targetWords',
    { kind: 'target_words_cap', level, targetWords, maxTargetWords },
  )

/**
 * 502：分段路径丢段过多，成文残缺（md/23 D2 / md/27 §3）。
 *
 * 与 AI_INVALID_RESPONSE 分开报，是因为「结构没问题、只是没写完」和
 * 「模型返回了非法 JSON」对用户是两件事：前者缩短篇幅有用，后者只能重试。
 */
export const articleTooIncomplete = ({ accepted, total, actualWords, minAcceptance }) =>
  new ApiError(
    502,
    ERROR_CODES.ARTICLE_TOO_INCOMPLETE,
    `这篇文章只写出来 ${accepted} / ${total} 段（${actualWords} 个英文单词），内容不完整。`
      + '请缩短篇幅后重试。',
    'targetWords',
    { kind: 'segment_acceptance', accepted, total, actualWords, minAcceptance },
  )

/**
 * 422：已知词汇量达不到该难度的下限（md/20 §2.1 的 B 门）。
 *
 * `available` 是**并集**后的已知词数（含基础词表），不是个人词库条数——
 * 用户看到「当前已有 1180 个」时会疑惑自己只背了 700 个，所以文案里写明口径。
 */
export const knownWordsTooSmall = ({ level, required, available }) =>
  new ApiError(
    422,
    ERROR_CODES.VOCABULARY_TOO_SMALL,
    `${LEVEL_LABELS[level] ?? level}模式需要认识约 ${required} 个单词（个人词库 + 基础词表），`
      + `当前已有 ${available} 个（还差 ${Math.max(0, required - available)} 个）。`
      + '请添加更多单词，或降低难度。',
    'level',
    {
      kind: 'known_words',
      level,
      required,
      available,
      shortage: Math.max(0, required - available),
    },
  )
