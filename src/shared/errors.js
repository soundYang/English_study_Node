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
  // ——— 基础词表（md/29）：只有 421 个实词可改，功能词 / 日历词 / 缩写只读 ———
  FUNCTION_WORD_IMMUTABLE: 'FUNCTION_WORD_IMMUTABLE',
  BASIC_WORD_READONLY: 'BASIC_WORD_READONLY',
  BASIC_WORD_NOT_FOUND: 'BASIC_WORD_NOT_FOUND',
  BASIC_WORD_ALREADY_REMOVED: 'BASIC_WORD_ALREADY_REMOVED',
  BASIC_WORD_ALREADY_LEARNED: 'BASIC_WORD_ALREADY_LEARNED',
  BASIC_WORD_NOT_REMOVED: 'BASIC_WORD_NOT_REMOVED',
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
  // ——— 生成任务（md/31）：任务外壳自己的三个码，与生成侧业务码并存 ———
  // 生成失败仍然复用上面的错误码（VOCABULARY_TOO_SMALL 等），
  // 这三个只描述「任务本身」的状态，前端不必为它们重写分支。
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_IN_PROGRESS: 'TASK_IN_PROGRESS',
  TASK_INTERRUPTED: 'TASK_INTERRUPTED',
  // ——— 鉴权（md/33 §6.3）：验证码两个码**必须分开** ———
  // CAPTCHA_INVALID = 码错了（图还能用，但一次失败即作废，见 captcha.model.js）；
  // CAPTCHA_EXPIRED = 过期或已被用过，前端必须自动换一张图。
  // 合成一个码的话，前端分不清「提示输错」还是「换图」。
  CAPTCHA_INVALID: 'CAPTCHA_INVALID',
  CAPTCHA_EXPIRED: 'CAPTCHA_EXPIRED',
  // 连续登录失败后强制要求验证码。与 CAPTCHA_INVALID 分开：
  // 那个是「你填错了」，这个是「你还没填」——前端据此决定要不要把验证码区显示出来
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_USERNAME_TAKEN: 'AUTH_USERNAME_TAKEN',
  AUTH_PHONE_TAKEN: 'AUTH_PHONE_TAKEN',
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
 * 404：任务不存在或已被 TTL 清掉（md/31 §7）。
 *
 * 与 READING_NOT_FOUND 分开：任务过期 24 h 后必然出现，前端要引导去历史页，
 * 而不是显示「练习不存在」。
 */
export const taskNotFound = () =>
  notFound(ERROR_CODES.TASK_NOT_FOUND, '生成任务不存在或已过期，请重新生成')

/**
 * 409：同用户已有任务在跑，且这次请求的参数不同（md/31 §5）。
 *
 * 不直接复用跑到一半的任务——用户要的是 300 词，给他 200 词的进度是错的。
 * `details.taskId` 让前端能切到那个任务的轮询上。
 */
export const taskInProgress = ({ taskId }) =>
  // conflict() 只到 field 为止，这里要带 details 只能直接用 ApiError
  new ApiError(
    409,
    ERROR_CODES.TASK_IN_PROGRESS,
    '上一个生成任务还在进行中，请等它结束后再试',
    '',
    { taskId },
  )

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
 *
 * `finalModeUnlocked` 让前端能区分「提高难度就有」与「再难也只有 600」：
 * 没解锁时文案提示去攒个人词库，而不是让用户反复点滑块试。
 */
export const targetWordsTooLong = ({ level, targetWords, maxTargetWords, finalModeUnlocked = false }) =>
  new ApiError(
    400,
    ERROR_CODES.INVALID_REQUEST,
    `${LEVEL_LABELS[level] ?? level}模式最高支持 ${maxTargetWords} 词（本次请求 ${targetWords} 词）。`
      + (finalModeUnlocked ? '请缩短篇幅。' : '请缩短篇幅，或提高难度。'),
    'targetWords',
    { kind: 'target_words_cap', level, targetWords, maxTargetWords, finalModeUnlocked },
  )

/**
 * 400：要写最终模式的长文，但个人词库还没攒够（md/30 §2.2、§7.4）。
 *
 * 和 `targetWordsTooLong` 分开报：同样是 400，用户能做的动作完全不同——
 * 这个是「去背单词」，那个是「缩短篇幅」。合并成一个码，前端只能两句话都写。
 *
 * `metric: 'personal_words'` 强调口径：解锁看的是个人词库条数（learning + mastered），
 * **不是** `knownWords`（那个还含 600 个基础词）。差 618 的两个数并列会让人以为算错了。
 */
export const finalModeLocked = ({ targetWords, available, unlockAt }) => {
  const shortage = Math.max(0, unlockAt - available)

  return new ApiError(
    400,
    ERROR_CODES.INVALID_REQUEST,
    `写 ${targetWords} 词的长文属于「最终模式」，需要个人词库里有 ${unlockAt} 个单词才能解锁，`
      + `当前有 ${available} 个（还差 ${shortage} 个）。请缩短篇幅，或继续添加单词。`,
    'targetWords',
    { kind: 'final_mode_locked', targetWords, metric: 'personal_words', unlockAt, available, shortage },
  )
}

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
 * 422：已知词汇量写不了这么长的文章（md/30 §7.4，取代旧的 B 门 `knownWordsTooSmall`）。
 *
 * 门槛不再按难度写死，而是随篇幅走：`minKnownFor(N)`。
 * `required` 就是这个数，前端拿它画进度条即可，不必自己折算。
 *
 * `available` 是**并集**后的已知词数（含基础词表），不是个人词库条数——
 * 用户看到「当前已有 1180 个」时会疑惑自己只背了 700 个，所以文案里写明口径。
 */
export const knownWordsBelowLength = ({ level, targetWords, required, available }) =>
  new ApiError(
    422,
    ERROR_CODES.VOCABULARY_TOO_SMALL,
    `写 ${targetWords} 词的文章需要认识约 ${required} 个单词（个人词库 + 基础词表），`
      + `当前已有 ${available} 个（还差 ${Math.max(0, required - available)} 个）。`
      + '请缩短篇幅，或添加更多单词。',
    'targetWords',
    {
      kind: 'known_words',
      level,
      targetWords,
      required,
      available,
      shortage: Math.max(0, required - available),
    },
  )

/**
 * 基础词表的三个只读原因（md/29）。
 *
 * 三种词在页面上都会被列出来，但只有 421 个实词能改：
 *   · 功能词 —— 缺了 the / is / and 任何句子都写不出来，移除没有意义；
 *   · 日历词 / 缩写 —— 系统维护的放行表，不是用户的词汇积累。
 * 分成两个 code 是因为前端文案不同：一个是「这个词不能移除」，一个是「系统词表不可修改」。
 */
export const functionWordImmutable = (word) =>
  new ApiError(
    403,
    ERROR_CODES.FUNCTION_WORD_IMMUTABLE,
    `“${word}”是功能词，文章里必须用到，不能移除。`,
    '',
    { word, kind: 'function_word' },
  )

export const basicWordReadonly = (word, kind) =>
  new ApiError(
    403,
    ERROR_CODES.BASIC_WORD_READONLY,
    kind === 'abbreviation'
      ? `“${word}”是系统收录的缩写，不可修改。`
      : `“${word}”是星期或月份，由系统维护，不可修改。`,
    '',
    { word, kind },
  )

export const basicWordNotFound = (word) =>
  notFound(ERROR_CODES.BASIC_WORD_NOT_FOUND, `“${word}”不在基础词表、日历词或缩写表里。`)

export const basicWordAlreadyRemoved = (word) =>
  conflict(ERROR_CODES.BASIC_WORD_ALREADY_REMOVED, `“${word}”已经标记为不认识了。`)

/** 个人词库状态的中文名；提示语里不要直接露 new / mastered */
const PERSONAL_STATUS_LABELS = Object.freeze({ new: '不认识', learning: '学习中', mastered: '已掌握' })

/**
 * 这个词已经在个人词库里（learning / mastered / 手动加的 new）。
 *
 * 不直接改状态是有意为之：`status` 上挂着复习时间与曝光次数，
 * 用基础词页的操作覆盖它，等于把用户的学习进度抹掉。
 */
export const basicWordAlreadyLearned = (word, status) =>
  conflict(
    ERROR_CODES.BASIC_WORD_ALREADY_LEARNED,
    `“${word}”已经在你的词库里（${PERSONAL_STATUS_LABELS[status] ?? status}），`
      + '请到词汇页修改它的状态。',
  )

export const basicWordNotRemoved = (word) =>
  conflict(ERROR_CODES.BASIC_WORD_NOT_REMOVED, `“${word}”没有被移除，无需恢复。`)

/**
 * 400：验证码输错了（md/33 §5.3）。
 *
 * 挂 `captchaCode` 字段，前端可以直接把提示写在输入框下面。
 * 注意语义：**这次输错的同时，这张图已经被消耗掉了**（校验即删除），
 * 所以前端无论如何都要换一张图——只是文案不同：这里说「不对」，
 * CAPTCHA_EXPIRED 说「已过期」。
 */
export const captchaInvalid = () =>
  new ApiError(400, ERROR_CODES.CAPTCHA_INVALID, '验证码不对，请重新输入', 'captchaCode')

/** 400：验证码过期，或者已经被用过一次（含刚才失败的那次） */
export const captchaExpired = () =>
  new ApiError(400, ERROR_CODES.CAPTCHA_EXPIRED, '验证码已过期，请换一张', 'captchaCode')

export const captchaRequired = () =>
  new ApiError(
    400,
    ERROR_CODES.CAPTCHA_REQUIRED,
    '登录失败次数较多，请输入图形验证码后重试',
    'captchaCode',
  )

/**
 * 401：需要登录（md/33 §6.3）。
 *
 * **前端请按 `err.code === 'AUTH_REQUIRED'` 判断**，不要用 `instanceof AuthError`：
 * `normalizeApiError` 先命中 `payload.code` 分支，带 code 的 401 会被归一化成
 * BusinessError，AuthError 那段走不到（见 md/33 §6.4）。
 */
export const authRequired = () =>
  new ApiError(401, ERROR_CODES.AUTH_REQUIRED, '请先登录')

/**
 * 401：用户名或密码错。
 *
 * **不区分是哪一个错**，也不区分「用户不存在」：分开报等于把账号枚举做成了功能。
 * 用户不存在时也要跑一次 scrypt（用 getDummyHash 陪跑），否则响应耗时差异同样能枚举。
 */
export const invalidCredentials = () =>
  new ApiError(401, ERROR_CODES.AUTH_INVALID_CREDENTIALS, '用户名或密码不正确', 'password')

export const usernameTaken = () =>
  conflict(ERROR_CODES.AUTH_USERNAME_TAKEN, '这个用户名已经被使用了', 'username')

export const phoneTaken = () =>
  conflict(ERROR_CODES.AUTH_PHONE_TAKEN, '这个手机号已经注册过了', 'phone')
