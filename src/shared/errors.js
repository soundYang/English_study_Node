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
  // 个人词库到上限（md/44 §5.6）。与 WORD_EXISTS 分开：
  // 前端要提示「去删一些旧词」，而不是「这个词加过了」
  WORD_LIMIT_REACHED: 'WORD_LIMIT_REACHED',
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
  // 用户自选词里有不在词库（或已标 new）的词（md/54）。
  // 与 VOCABULARY_TOO_SMALL 分开：那个是「词不够」，这个要用户改选词
  FOCUS_WORDS_NOT_LEARNED: 'FOCUS_WORDS_NOT_LEARNED',
  VOCABULARY_VALIDATION_FAILED: 'VOCABULARY_VALIDATION_FAILED',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  // md/55：上游忙（熔断打开 / 信号量排队超时）与整篇超时，前端要能分开提示。
  AI_PROVIDER_BUSY: 'AI_PROVIDER_BUSY',
  AI_INVALID_RESPONSE: 'AI_INVALID_RESPONSE',
  // 任务调度器队满（503）：请求在扣额度之前就被拒，不会留下任务。
  GENERATION_SATURATED: 'GENERATION_SATURATED',
  // 整篇 deadline 到（504）：任务 failed，额度退回，可以 retry。
  GENERATION_TIMEOUT: 'GENERATION_TIMEOUT',
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
  // ——— 每日额度（md/35）———
  // 与 RATE_LIMITED 分开：那个是「等一分钟」，这个是「等明天 0 点」。
  // 合成一个码的话，前端只能把两句文案都写出来，用户不知道该等多久。
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  // ——— 全局免费池（md/36）———
  // 与 QUOTA_EXCEEDED 分开：那个是「你个人今天用完了」，等 0 点就恢复；
  // 这个是「全站免费额度到顶了」，等到明天也不会恢复，必须换自己的 API Key
  FREE_BUDGET_EXHAUSTED: 'FREE_BUDGET_EXHAUSTED',
  // ——— 用户自备 API Key（md/43）———
  // 四个码分别对应：功能没开 / Key 被拒 / 暂时验证不了 / 任务执行时 Key 没了。
  // 生成时的「Key 失效」用 403 而不是 401：前端见到 401 会清 token 并踢回登录页
  USER_API_KEY_DISABLED: 'USER_API_KEY_DISABLED',
  USER_API_KEY_INVALID: 'USER_API_KEY_INVALID',
  USER_API_KEY_VERIFY_FAILED: 'USER_API_KEY_VERIFY_FAILED',
  USER_API_KEY_MISSING: 'USER_API_KEY_MISSING',
  // ——— 导入的 AI 识别（md/49）———
  // 请求级默认关（mode=local）；勾了 mode=ai 才发现没接自备 Key，用 409 而不是 403：
  // 403 表示「你没资格」，409 表示「当前状态不满足」，前端据此引导去个人中心
  USER_API_KEY_REQUIRED: 'USER_API_KEY_REQUIRED',
  IMPORT_AI_DISABLED: 'IMPORT_AI_DISABLED',
  // ——— 管理员后台（md/37）———
  // 与 AUTH_REQUIRED 分开：前端拿用户令牌打管理端时必须能分辨
  // 「没登录」和「登的是用户、不是管理员」，否则会静默跳转到登录页而不是报错
  ADMIN_AUTH_REQUIRED: 'ADMIN_AUTH_REQUIRED',
  // 登录失败**不区分**用户名错与密码错（少给爆破者一个字节的信息）
  ADMIN_AUTH_FAILED: 'ADMIN_AUTH_FAILED',
  ADMIN_USER_NOT_FOUND: 'ADMIN_USER_NOT_FOUND',
  FEEDBACK_TOO_SHORT: 'FEEDBACK_TOO_SHORT',
  FEEDBACK_TOO_LONG: 'FEEDBACK_TOO_LONG',
  FEEDBACK_NOT_FOUND: 'FEEDBACK_NOT_FOUND',
  // ——— 文件导入（md/48）———
  // 三个码对应三种「用户能做点什么」的失败，不能合成一个：
  //   415 = 换个格式（另存为 docx / xlsx）
  //   422 FILE_PARSE_FAILED = 文件坏了 / 加密了，重试无用
  //   422 OCR_FAILED = 图片里没认出来，换张清楚的照片
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FILE_PARSE_FAILED: 'FILE_PARSE_FAILED',
  OCR_FAILED: 'OCR_FAILED',
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

/**
 * 409：个人词库达到上限（md/44 §5.6）。
 *
 * 只在**新建**时检查；合并已有词不受限——否则用户连「把标错的词改回来」都做不了。
 */
export const wordLimitReached = (limit) =>
  new ApiError(
    409,
    ERROR_CODES.WORD_LIMIT_REACHED,
    `个人词库已达上限（${limit} 词），请先删除一些再添加`,
    'word',
    { limit },
  )

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
 * md/54：用户自选了目标词时，自动补词的配额变小，门槛也按**剩余配额**折算。
 * 这时 `requiredWords` 是总目标词数、`remainingRequired` 是还需要系统补的数；
 * 文案要把「你已选 S 个」说出来，否则用户会以为系统没算他的选择。
 *
 * @param {{
 *   required: number,          // 折算后的已学词门槛（neededVocab）
 *   available: number,         // 可用于补词的候选词数（supply）
 *   requiredWords: number,     // 篇幅换算出的目标词总数
 *   targetWords: number,       // 用户请求的篇幅
 *   scope: string[],
 *   level: string,
 *   selectedCount?: number,    // md/54：用户显式选了几个（0 = 没选）
 *   remainingRequired?: number // md/54：还需要自动补几个
 * }} payload
 */
export const vocabularyTooSmall = ({
  required,
  available,
  requiredWords,
  targetWords,
  scope,
  level,
  selectedCount = 0,
  remainingRequired = requiredWords,
}) => {
  const intro = selectedCount > 0
    ? `${LEVEL_LABELS[level] ?? level}模式写 ${targetWords} 词的文章还需要约 ${remainingRequired} 个自动目标词`
      + `（你已选 ${selectedCount} 个），折算下来至少还需要 ${required} 个其他已学单词，`
      + `当前符合条件的只有 ${available} 个（还差 ${Math.max(0, required - available)} 个）。`
    : `${LEVEL_LABELS[level] ?? level}模式写 ${targetWords} 词的文章需要约 ${requiredWords} 个目标词，`
      + `折算下来至少要有 ${required} 个已学单词，当前符合条件的只有 ${available} 个`
      + `（还差 ${Math.max(0, required - available)} 个）。`

  return new ApiError(
    422,
    ERROR_CODES.VOCABULARY_TOO_SMALL,
    intro + '请添加更多单词，或缩短篇幅、降低难度。',
    'targetWords',
    // kind 让前端区分两道 422：目标词凑不齐（缩篇幅/降难度）与已知词汇量不够（加词）。
    // selectedCount 只在真的有选词时才出现，保持老响应的 details 形状不变
    {
      kind: 'target_words',
      required,
      available,
      requiredWords,
      targetWords,
      scope,
      level,
      ...(selectedCount > 0 ? { selectedCount, remainingRequired } : {}),
    },
  )
}

/**
 * 422：用户显式指定的词里有不在个人词库（learning / mastered）的（md/54）。
 *
 * 与 `vocabularyTooSmall` 分开：那个是「你的词总量不够」，这个只需改选词或把词加进词库，
 * 前端要做的事情完全不同。`details.words` 只回前 20 个，`count` 是完整数量——
 * 和 violations 的截断口径一致，避免一个恶意/异常请求把响应撑大。
 */
export const focusWordsNotLearned = ({ words, max = null }) => {
  const list = [...new Set((words ?? []).map((word) => String(word)))]
  const shown = list.slice(0, 20)

  return new ApiError(
    422,
    ERROR_CODES.FOCUS_WORDS_NOT_LEARNED,
    `有 ${list.length} 个词不在你的词库里，或已被标记为「不认识」：`
      + `${shown.join('、')}${list.length > shown.length ? ' 等' : ''}。`
      + '只有「学习中」和「已掌握」的词可以指定生成。',
    'focusWords',
    {
      kind: 'focus_words',
      words: shown,
      count: list.length,
      ...(max === null ? {} : { max }),
    },
  )
}

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

/**
 * 429：今天的生成额度用完了（md/35 §7.2）。
 *
 * `scope` 说明是哪把锁挡住的（account / device / network），前端据此换文案：
 * 「这个账号今天用完了」和「这台设备今天用完了」用户能做的事不一样。
 * `resetAt` 是北京时间次日 0 点的 ISO 串，errorHandler 会据此补 `Retry-After`。
 *
 * **不要**同时发 `RateLimit` 头：前端 `retryAfterOf` 优先读它，那是分钟级冷却的语义。
 */
export const quotaExceeded = ({ scope, limit, used, resetAt }) =>
  new ApiError(
    429,
    ERROR_CODES.QUOTA_EXCEEDED,
    `今天的 ${limit} 次生成额度已用完，明天 00:00 重置`,
    '',
    { scope, limit, used, resetAt: resetAt.toISOString() },
  )

/**
 * 503：全站免费 token 预算用完（md/36）。
 *
 * 和 `QUOTA_EXCEEDED` 的区别是**恢复方式**：这个等到明天也不会好，
 * 用户唯一的出路是接入自己的 API Key。所以：
 *   · 不用 429 —— 429 的语义是「过一会儿再来」；
 *   · 不发 Retry-After —— 没有可等待的重置时间；
 *   · 文案直接给出下一步，不要只说「服务暂不可用」。
 *
 * `usedTokens` 可能比 `limitTokens` 略高：并发请求会同时通过闸门，
 * 这是可接受的超调，不是计费错误。
 */
export const freeBudgetExhausted = ({ limitTokens, usedTokens }) =>
  new ApiError(
    503,
    ERROR_CODES.FREE_BUDGET_EXHAUSTED,
    '免费生成额度已用完，请接入自己的 API Key 后继续使用',
    '',
    { limitTokens, usedTokens },
  )

/**
 * 503：本实例的任务队列已满（md/55 §3.2）。
 *
 * 这个错误必须在扣每日额度之前抛出：用户被拒时既没有任务，也没有少一次。
 * `retryAfter` 只给前端做按钮冷却，不代表队列一定会在这么久内腾出位置。
 */
export const generationSaturated = ({
  retryAfter = 5,
  active = 0,
  queued = 0,
  maxActive = 0,
  maxQueue = 0,
} = {}) =>
  new ApiError(
    503,
    ERROR_CODES.GENERATION_SATURATED,
    '当前生成人数较多，请稍后再试',
    '',
    { retryAfter, active, queued, maxActive, maxQueue },
  )

/**
 * 503：上游熔断打开，或等上游并发槽超时（md/55 §4.5）。
 *
 * 与 `AI_PROVIDER_ERROR` 分开：上游并没有返回错误，只是我们主动不再打它；
 * 前端提示「AI 服务繁忙」并允许稍后重试，而不是显示一次失败。
 */
export const aiProviderBusy = ({ retryAfter = 10 } = {}) =>
  new ApiError(
    503,
    ERROR_CODES.AI_PROVIDER_BUSY,
    'AI 服务暂时繁忙，请稍后再试',
    '',
    { retryAfter },
  )

/**
 * 504：整篇生成超过 deadline（md/55 §4.7）。
 *
 * 同步接口直接返回 504；任务侧写成 failed + 本 code，额度自动退回。
 * 不放在 `NON_RETRYABLE` 里——用户可以直接 retry 同一个任务。
 */
export const generationTimeout = ({ deadlineMs = 0 } = {}) =>
  new ApiError(
    504,
    ERROR_CODES.GENERATION_TIMEOUT,
    '这次生成超时了，请重试',
    '',
    { deadlineMs },
  )

// ——— 用户自备 API Key（md/43）———

/** 503：服务端没开功能（开关关闭 / 没配 USER_API_KEY_SECRET） */
export const userApiKeyDisabled = () =>
  new ApiError(503, ERROR_CODES.USER_API_KEY_DISABLED, '自备 API Key 功能暂未开启')

/**
 * 400：导入 / 校验时被上游拒绝。
 * 挂 `apiKey` 字段，前端能把提示写在输入框下面。
 */
export const userApiKeyInvalid = () =>
  new ApiError(
    400,
    ERROR_CODES.USER_API_KEY_INVALID,
    '这把 API Key 无效或已过期，请检查后重新导入',
    'apiKey',
  )

/**
 * 403：生成过程中上游拒绝了用户自己的 Key。
 *
 * **不能用 401**：前端 `request.js` 见到 401 会清 token、踢回登录页，
 * 而这里登录状态完全正常，只是 Key 失效。也不能用 400——
 * 生成页没有 `apiKey` 输入框，字段错误会被挂到不存在的表单上。
 */
export const userApiKeyExpired = () =>
  new ApiError(
    403,
    ERROR_CODES.USER_API_KEY_INVALID,
    '你的 API Key 已失效，请到个人中心重新导入',
  )

/** 502：校验时网络 / 上游 5xx，无法判断 Key 是否有效 */
export const userApiKeyVerifyFailed = () =>
  new ApiError(
    502,
    ERROR_CODES.USER_API_KEY_VERIFY_FAILED,
    '暂时无法验证这把 API Key，请稍后再试',
  )

/** 409：任务创建时用的是自备 Key，执行时已经找不到（被删 / 解不开） */
export const userApiKeyMissing = () =>
  new ApiError(
    409,
    ERROR_CODES.USER_API_KEY_MISSING,
    '生成任务使用的 API Key 已不存在，请到个人中心重新导入后再试',
  )

// ——— 导入的 AI 识别（md/49）———

/**
 * 409：勾了「用 AI 识别」，但账号没有可用的自备 Key。
 *
 * **不回退免费池**：AI 识别花的是站方的钱还是用户的钱，必须由用户自己的
 * 凭据决定。没有 Key 就明确说不满足条件，让用户去接入，而不是偷偷用免费额度。
 */
export const userApiKeyRequired = () =>
  new ApiError(
    409,
    ERROR_CODES.USER_API_KEY_REQUIRED,
    '开启 AI 识别需要先在个人中心接入你自己的 API Key',
  )

/** 403：服务端把导入 AI 的总开关关了（止血用，不影响本地解析） */
export const importAiDisabled = () =>
  new ApiError(403, ERROR_CODES.IMPORT_AI_DISABLED, 'AI 识别暂未开放，请使用本地识别')

/** 502：整次 AI 导入超过时间预算，且一条结果都没拿到 */
export const importAiTimeout = () =>
  new ApiError(502, ERROR_CODES.AI_PROVIDER_ERROR, 'AI 整理超时了，请重试或改用本地识别')

/** 502：模型两次返回的都解析不出 `{"items":[...]}` */
export const importAiInvalidResponse = () =>
  new ApiError(
    502,
    ERROR_CODES.AI_INVALID_RESPONSE,
    'AI 返回的内容看不懂，请重试或改用本地识别',
  )

// ——— 管理员后台（md/37）———

/** 401：没带管理员令牌 / 令牌无效 / 已过期 */
export const adminAuthRequired = () =>
  new ApiError(401, ERROR_CODES.ADMIN_AUTH_REQUIRED, '管理员登录已失效，请重新登录')

/**
 * 401：账号或密码错。
 * **故意不区分**两种情况——区分等于告诉爆破者「用户名对了」。
 */
export const adminAuthFailed = () =>
  new ApiError(401, ERROR_CODES.ADMIN_AUTH_FAILED, '账号或密码不正确')

/** 404：用户不存在（dataKey 拼错或用户已被删） */
export const adminUserNotFound = () =>
  notFound(ERROR_CODES.ADMIN_USER_NOT_FOUND, '用户不存在')

export const feedbackNotFound = () =>
  notFound(ERROR_CODES.FEEDBACK_NOT_FOUND, '反馈不存在')

/**
 * 400：反馈内容太短 / 太长。
 *
 * 不复用 `badRequest`（INVALID_REQUEST）：前端要把提示挂到输入框下面，
 * 而且要显示「还差几个字」这类计数，单独的码更好分支。
 */
export const feedbackTooShort = (minLength) =>
  new ApiError(
    400,
    ERROR_CODES.FEEDBACK_TOO_SHORT,
    `反馈内容至少 ${minLength} 个字`,
    'content',
    { minLength },
  )

export const feedbackTooLong = (maxLength) =>
  new ApiError(
    400,
    ERROR_CODES.FEEDBACK_TOO_LONG,
    `反馈内容最多 ${maxLength} 个字`,
    'content',
    { maxLength },
  )

/** 429：同一设备每天 5 条、同一 IP 每天 20 条反馈（md/37 §5.1、md/45 M3） */
export const feedbackFlood = (limit) =>
  new ApiError(
    429,
    ERROR_CODES.RATE_LIMITED,
    `今天提交的反馈太多了（每天最多 ${limit} 条），请明天再来`,
    '',
    { limit, scope: 'feedback' },
  )

// ——— 文件导入（md/48） ———

/** 415：格式不支持。message 里必须给出下一步，否则用户不知道该怎么改 */
export const unsupportedMediaType = (detail) =>
  new ApiError(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, detail, 'file')

/** 413：文件超过上传上限 */
export const payloadTooLarge = (maxBytes) =>
  new ApiError(
    413,
    ERROR_CODES.PAYLOAD_TOO_LARGE,
    `文件太大了，最大 ${Math.round(maxBytes / 1024 / 1024)}MB`,
    'file',
    { maxBytes },
  )

/** 422：文件结构坏了 / 加密了 / 被 zip 炸弹防护挡下 */
export const fileParseFailed = (message, details = null) =>
  new ApiError(422, ERROR_CODES.FILE_PARSE_FAILED, message, 'file', details)

/** 422：图片里没识别出单词（换张清楚的照片比重试有用） */
export const ocrFailed = (message) =>
  new ApiError(422, ERROR_CODES.OCR_FAILED, message, 'file')
