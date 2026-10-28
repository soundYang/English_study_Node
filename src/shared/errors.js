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
 * 全部 16 个业务错误码（《后端接口说明》§4.7）。
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

/** 难度英文枚举 → 中文。不要把 easy/hard 直接塞进给用户看的提示语 */
const LEVEL_LABELS = Object.freeze({ easy: '简单', medium: '中等', hard: '困难' })

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
    { required, available, requiredWords, targetWords, scope, level },
  )
