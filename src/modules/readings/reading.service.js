import mongoose from 'mongoose'

import { config } from '../../config/index.js'
import {
  ApiError,
  ERROR_CODES,
  conflict,
  finalModeLocked,
  knownWordsBelowLength,
  readingNotFound,
  targetWordsTooLong,
  vocabularyTooSmall,
} from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { findEntry } from '../dictionary/dictionary.loader.js'
import { wordRepository } from '../words/word.repository.js'
import { ABBREVIATIONS, ABBREVIATION_WORDS } from './abbreviations.js'
import {
  buildExpandMessages,
  buildFinishMessages,
  buildMessages,
  buildPlanMessages,
  buildRepairMessages,
  buildSegmentedSystem,
} from './ai.prompt.js'
import { parseAiContent, validateAiReading } from './ai.schema.js'
import { ignoredFunctionWordRemovals } from './basic-words.js'
import { calendarWords } from './calendar-words.js'
import {
  FINAL_MODE_MAX_WORDS,
  FINAL_MODE_PERSONAL_WORDS,
  baseMaxWordsFor,
  isFinalMode,
  isFinalModeUnlocked,
  lengthLadder,
  maxTargetWordsFor,
  minKnownFor,
} from './capacity-table.js'
import { measureDifficulty } from './difficulty.js'
import { measureKnownVocabulary, unknownBudgetFor } from './level-limits.js'
import { callModel, sumUsage } from './model-call.js'
import { buildSegmentPlan, planSegmentCount } from './plan.service.js'
import { generateSegmented } from './segmented.service.js'
import { measureTargetCoverage } from './target-coverage.js'
import { classifyLength, countWords, planAcceptedRange, planWordRange } from './word-count.js'
import { generationFailureRepository as failureRepo } from './generation-failure.repository.js'
import { toHistoryItem, toResultDto, toSafeDto } from './reading.dto.js'
import { readingRepository as repo } from './reading.repository.js'
import {
  HISTORY_LEVEL_FILTERS,
  LEVELS,
  capacityQuerySchema,
  generateReadingSchema,
  submitReadingSchema,
} from './reading.schema.js'
import { buildTargetPlan } from './target-plan.js'
import { collectWordForms, validateArticle } from './vocabulary.service.js'
import { selectVocabularyPool } from './vocabulary-pool.js'
import {
  basicWordsVersions,
  codeVersion,
  irregularFormsVersion,
} from './versions.js'

/**
 * 覆盖度告警线（md/21 W5）：M2 阶段只 warn，M3 再决定是否作为修复触发条件。
 * 0.9 来自「目标词必须全部出现」这条产品承诺的容忍下限。
 */
const TARGET_COVERAGE_ALERT = 0.9

/**
 * 候选词里，哪几个真的出现在这篇正文中。
 *
 * 用集合交集而不是 candidates.filter(w => article.includes(w))：
 * 文章几百个 token、词表几千个词，逐词 includes 是 O(n×m) 的字符串扫描。
 *
 * @param {string[]} candidates 候选词（用户词库 / 本篇候选池）
 * @param {string} article 正文
 * @returns {string[]} 命中的候选词，去重
 */
function pickUsedWords(candidates, article) {
  const candidateSet = new Set(candidates.map((word) => String(word).toLowerCase()))
  const forms = collectWordForms(article)

  return [...forms].filter((word) => candidateSet.has(word))
}

/**
 * 失败时用来判断"是不是被截断了"。
 * 只留长度和首尾片段，整篇正文不进日志。
 */
function describeContent(content) {
  const text = String(content ?? '')

  return {
    length: text.length,
    head: text.slice(0, 80),
    tail: text.slice(-80),
  }
}

/** 解析 + 结构校验一步到位，返回统一形状 */
function inspect(content, params) {
  const payload = parseAiContent(content)

  if (!payload) return { ok: false, reason: '返回内容不是合法 JSON' }

  // 模型按系统提示词第 8 条主动认输时，这是业务结果而不是结构错误
  if (payload.error === 'INSUFFICIENT_VOCABULARY') {
    return { ok: false, insufficient: true, reason: 'INSUFFICIENT_VOCABULARY' }
  }

  return validateAiReading(payload, params)
}

function insufficientVocabularyError() {
  return new ApiError(
    422,
    ERROR_CODES.INSUFFICIENT_VOCABULARY,
    '当前词汇量不足以写出通顺的文章，请先添加更多单词',
  )
}

/**
 * 把一轮产出判成「还能更好」或「可以收工」。
 *
 * 优先级：结构 → 篇幅 → 用词。
 * 篇幅优先于用词：用词修正实测会把文章改长（231→234、277→279），
 * 先修词会让本已超长的正文更难收拾；先压到目标篇幅，短文章带出的高级词也更少。
 * 篇幅走独立的 maxLengthRounds 额度，不会被结构/用词吃光。
 *
 * @returns {{
 *   result: object,
 *   vocabulary?: { unknownWords: string[], violations: Array },
 *   actualWords?: number,
 *   feedback: null | { type: 'structure'|'questions'|'vocabulary'|'word_count'|'word_expand', reason: string, violations?: Array, actualWords?: number, range?: object },
 * }}
 */
function evaluate({ content, params, allowedWords, range, unknownBudget }) {
  const result = inspect(content, params)

  if (result.insufficient) return { result, feedback: null }
  if (!result.ok) {
    // 题目不合格（md/21 W7）只重写题目，正文保留；其余结构问题整篇重写。
    // 分这一刀是为了不把一篇文章重写两遍——正文已经过了词表与篇幅校验。
    const type = result.kind === 'questions' ? 'questions' : 'structure'
    return { result, feedback: { type, reason: result.reason, range } }
  }

  // 每轮都数一次：写进 rounds[]，调篇幅策略时能看出「首轮 290 → 重写 228」
  const actualWords = countWords(result.data.article)
  const acceptedRange = planAcceptedRange(params.targetWords)

  // 篇幅优先于用词：实测用词修正会稳定把文章改长（231→234、277→279），
  // 先修词等于把超长的问题放大。先重写成目标篇幅，篇幅短了带出的高级词也少。
  //
  // 判的是**验收上界**（1.15N），不是提示词上界（1.1N，md/30 §6-1）。
  // 两者相等时，模型照提示词写到上限就触发整篇重写——白烧一轮，
  // 而重写又会带出新一批表外词。提示词收紧 5% 之后这里保持原样，
  // 模型的「应写区间」和「被判超长的线」之间才有缓冲。
  if (actualWords > acceptedRange.max) {
    return {
      result,
      actualWords,
      feedback: {
        type: 'word_count',
        actualWords,
        range,
        reason: `正文有 ${actualWords} 个英文单词，超过上限 ${acceptedRange.max}`,
      },
    }
  }

  const vocabulary = validateArticle({
    article: result.data.article,
    allowedWords,
    names: result.data.names,
  })

  // 不超过预算的生词直接放行：预算按难度取（easy 0 / medium 3 / hard 5），
  // 它是产品承诺——easy 的「一个生词都没有」不是兜底，是卖点。
  if (vocabulary.unknownWords.length > unknownBudget) {
    return {
      result,
      vocabulary,
      actualWords,
      feedback: {
        type: 'vocabulary',
        reason: `使用了 ${vocabulary.unknownWords.length} 个不在词汇表内的单词`,
        violations: vocabulary.violations,
        range,
      },
    }
  }

  // 偏短（W6，md/21）：放在用词之后，因为用词修正天然会把文章写长
  // （实测 231→234、277→279），先扩写再把词改回去等于白做。
  // 默认 MAX_EXPAND_ROUNDS=0，这里只留一个可观察的 feedbackType，不追加调用。
  if (actualWords < acceptedRange.min) {
    return {
      result,
      vocabulary,
      actualWords,
      feedback: {
        type: 'word_expand',
        actualWords,
        range,
        acceptedRange,
        reason: `正文只有 ${actualWords} 个英文单词，低于验收下限 ${acceptedRange.min}`,
      },
    }
  }

  return { result, vocabulary, actualWords, feedback: null }
}

/**
 * 把一轮的判定结果写回该轮明细，并顺手更新失败诊断用的最新状态。
 *
 * 三件事必须贴在一起做：rounds 是给人看的明细，diag 是给 recordFailure 用的
 * 最后一帧。分开写时最容易漏的是 `unknownWords`——它在 evaluate() 里
 * 只存在于返回值上，不主动搬就会被丢掉。
 */
function recordRound({ rounds, state, content, diag }) {
  const last = rounds.at(-1)

  last.actualWords = state.actualWords ?? null
  last.unknownWords = state.vocabulary?.unknownWords ?? []
  // 没有 vocabulary 说明这一轮根本没跑词汇校验（结构不合法/篇幅超长），
  // 此时不写 counts，让它保持 undefined——写成 0 会被读成「查了，没问题」。
  // 唯一的事后补写：篇幅额度用尽仍超长时，generateReading 会对最终正文补查一次（§6.8）。
  if (state.vocabulary) last.counts = state.vocabulary.counts
  last.feedbackType = state.feedback?.type ?? null
  diag.state = state
  diag.content = content
}

/**
 * 把一个未学词补全成前端能直接渲染的条目。
 * 词典 → 缩写表 → 兜底，三级都查不到时 source 为 unknown，前端显示「暂无释义」。
 */
function describeNewWord(word) {
  const entry = findEntry(word)

  if (entry) {
    return {
      word,
      phonetic: { uk: entry.phonetic?.uk ?? '', us: entry.phonetic?.us ?? '' },
      senses: (entry.senses ?? []).map(({ pos, meaning }) => ({ pos, meaning })),
      source: 'dictionary',
    }
  }

  const abbreviation = ABBREVIATIONS[word]
  if (abbreviation) {
    return {
      word,
      phonetic: { uk: '', us: '' },
      senses: [{ pos: 'abbr.', meaning: `${abbreviation.expansion}；${abbreviation.meaning}` }],
      source: 'abbreviation',
    }
  }

  return { word, phonetic: { uk: '', us: '' }, senses: [], source: 'unknown' }
}

/**
 * 把一次失败落进 GenerationFailure。
 *
 * 原则：诊断数据永远不能盖过原始错误。写库失败只记日志，
 * 调用方继续抛原来的异常——用户该看到的是「生成失败」，不是「存日志失败」。
 *
 * 这里用 await 而不是 void：失败响应多几十毫秒，换的是每条样本都不丢。
 */
async function recordFailure(diag, error) {
  const state = diag.state

  const payload = {
    userId: diag.userId,

    level: diag.params?.level,
    targetWords: diag.params?.targetWords,
    questionCount: diag.params?.questionCount,
    scope: diag.selection?.scope ?? [],

    available: diag.selection?.available,
    poolSize: diag.selection?.poolSize,
    requiredWords: diag.selection?.requiredWords,
    allowedWordCount: diag.allowedWordCount,
    promptWordCount: diag.promptWordCount,

    // 上游异常没有业务错误码，落 INTERNAL_ERROR；原始 code 留在日志里
    errorCode: error?.code ?? ERROR_CODES.INTERNAL_ERROR,
    finalUnknownWords: state?.vocabulary?.unknownWords ?? [],
    finalViolations: state?.vocabulary?.violations ?? [],
    // 结构不合法时没有 data.article，退回模型原始输出：
    // 「被截断」和「JSON 格式错」要靠这个才分得开
    finalArticle: String(state?.result?.data?.article ?? diag.content ?? '').slice(0, 8000),

    rounds: diag.rounds,
    repairRounds: diag.repairRounds ?? 0,
    totalTokens: diag.totalTokens ?? 0,
    durationMs: diag.durationMs,

    // 快照要和成功样本记同一套，否则两类数据没法同框对比
    model: config.deepseekModel,
    strategy: config.generationStrategy,
    basicWordsVersion: diag.basicWords?.version ?? basicWordsVersions.hard,
    basicWordsLevel: diag.basicWords?.level ?? null,
    // W3 的门禁数字：失败样本多数正是死在这几道门上，不记就没法归因
    knownWords: diag.known?.knownWords,
    minKnown: diag.known?.minKnown,
    personalWords: diag.known?.personalWords,
    finalMode: diag.known?.finalMode,
    unknownBudget: diag.known?.unknownBudget,
    codeVersion,
  }

  try {
    await failureRepo.create(payload)
  } catch (saveError) {
    logger.error(
      { err: saveError, errorCode: payload.errorCode },
      'failed to record generation failure',
    )
  }
}

/**
 * POST /api/readings/generate
 *
 * 流程：参数校验 → 词汇量总闸 → 选池（scope + 优先级 + 难度比例）
 *       → 定目标词计划 → 组装允许词汇 → 调模型
 *       → 结构校验 → 用词校验 → 篇幅校验 →（最多 2 轮修正，三者共用）
 *       → 落库 → 返回安全 DTO。
 *
 * 放行规则：用词校验的预算是**按难度**给的（easy 0 / medium 3 / hard 5），
 * 预算内的生词带音标与释义落进 newWords，由前端做折叠提示。
 *
 * 闸门顺序不能换（md/30 §7.3）：
 *   1. 词数 < 20 → 422 INSUFFICIENT_VOCABULARY
 *   2. 解锁检查：hard 要写 601–1000 词但个人词库 < 3000 → 400 final_mode_locked
 *   3. 篇幅上限：超过本档可用上限 → 400 target_words_cap
 *   4. 最低词量：已知词 < minKnown(N) → 422 VOCABULARY_TOO_SMALL（kind=known_words）
 *   5. 候选池装不下本次篇幅 → 422 VOCABULARY_TOO_SMALL（kind=target_words，最终模式跳过）
 * 2–5 都在调模型之前。2 必须在 3、4 前面：还没解锁时报「词不够」，
 * 用户照着加词也过不去。判定与 /capacity 共用 `capacity-table.js` 同一套函数。
 *
 * 外面套一层薄壳只做一件事：**失败的生成也要留痕**。
 * 原实现预算耗尽后直接 throw，中间轮的违规词只进 pino stdout，
 * 想统计「违规词长什么样、属于哪一类」时既没有分母也没法回查。
 * 薄壳保证任何业务异常都落一条 GenerationFailure，同时原错误原样抛给调用方。
 */
export async function generateReading({ userId, body, signal }) {
  const diag = { userId, startedAt: Date.now(), rounds: [] }

  try {
    return await generateReadingInner({ userId, body, signal, diag })
  } catch (error) {
    // 用户主动断开不是「生成失败」，记下来只会污染成功率的分母
    if (signal?.aborted || error?.name === 'AbortError') throw error

    // 参数没过校验说明还没进生成流程。每条非法请求都存一份，
    // 真实样本会被大量的 400 淹掉，报表也就没法看了。
    if (!diag.params) throw error

    diag.durationMs = Date.now() - diag.startedAt
    // recordFailure 内部自己 try/catch：诊断数据丢了可以再跑一次，
    // 用户原本该看到的错误不能被写库失败顶掉
    await recordFailure(diag, error)

    throw error
  }
}

/**
 * 真正的生成流程。诊断信息走 diag 这个可变对象回传给外壳，
 * 用不到返回值——异常路径下根本没有返回值可用。
 */
async function generateReadingInner({ userId, body, signal, diag }) {
  const params = parseOrThrow(generateReadingSchema, body)
  diag.params = params

  // 篇幅上限曾经放在读库之前（纯参数判定）。md/30 §7 之后它要依赖个人词库规模
  // （hard 攒够 3000 词才能写到 1000），只能挪到读完词库之后，
  // 和「解锁检查 → 篇幅上限 → 最低词量」那道顺序一起排在下面。

  // 生词预算：按难度取，显式 MAX_UNKNOWN_WORDS 时全局覆盖
  const unknownBudget = unknownBudgetFor(params.level, config.maxUnknownWordsOverride)

  const rounds = diag.rounds

  // 只有 learning / mastered 算可用词汇，new 不算
  const vocabularyCount = await wordRepository.countVocabulary(userId)
  if (vocabularyCount < config.vocabularyThreshold) {
    throw new ApiError(
      422,
      ERROR_CODES.INSUFFICIENT_VOCABULARY,
      `当前已有 ${vocabularyCount} 个单词，至少需要 ${config.vocabularyThreshold} 个才能生成`,
    )
  }

  const words = await wordRepository.findVocabulary(userId)

  // 个人基础词：该难度的基础表 − 用户标记为 new 的词（功能词不可移除）
  const removedBasicWords = (await wordRepository.findNewWords(userId)).map((item) => item.word)
  const ignoredRemovals = ignoredFunctionWordRemovals(removedBasicWords)
  if (ignoredRemovals.length > 0) {
    logger.warn(
      { words: ignoredRemovals },
      'basic words: function words cannot be removed, ignored',
    )
  }

  // 已知词汇量：篇幅门槛（`minKnownFor`）与最终模式共用；顺便拿到扣掉 new 词之后的个人基础词
  const known = measureKnownVocabulary({
    level: params.level,
    learnedWords: words.map((item) => item.word),
    removedBasicWords,
  })
  const personalBasicWords = known.personalBasicWords

  // 版本信息在选池之前就记下：VOCABULARY_TOO_SMALL 的失败样本也要知道
  // 当时用的是哪一档词表，否则这批数据事后无法归因
  diag.basicWords = {
    level: params.level,
    size: personalBasicWords.length,
    removed: removedBasicWords.length - ignoredRemovals.length,
    // 全档统一 easy 600 之后，版本号也统一取 easy——记 requested level 的 hash
    // 会让人误以为 medium/hard 用的是各自那份表
    version: basicWordsVersions.easy,
  }
  // ——— 三道门槛（md/30 §7.3）———
  //
  // **顺序不能变：解锁检查 → 篇幅上限 → 最低词量。**
  // 反过来会出现「还没解锁，却先被告知词不够」——用户照着加词，加到 3000 也还是
  // 过不了，因为他真正缺的是「没解锁」这个状态。三道都在调模型之前。
  //
  // personalWords 用上面 countVocabulary 的结果：它和 findVocabulary 是同一个
  // 查询条件的两个视图（learning + mastered），不必再查一次库。
  const personalWords = vocabularyCount
  const finalMode = isFinalMode({
    level: params.level,
    targetWords: params.targetWords,
    personalWords,
  })
  const finalModeUnlocked = isFinalModeUnlocked({ personalWords })
  // 采样实例显式设了 MAX_TARGET_WORDS：它要验证「没攒够词也写得出」，必须绕开解锁。
  const overrideMax = Number.isInteger(config.maxTargetWordsOverride)
    ? config.maxTargetWordsOverride
    : null
  const maxTargetWords = overrideMax ?? maxTargetWordsFor(params.level, personalWords)
  // 最低已知词量随篇幅走（md/30 §7.2）。最终模式不查这条：
  // 它的真实闸门是 personalWords，再用 knownWords 拦一次只会自相矛盾。
  const minKnown = finalMode ? 0 : minKnownFor(params.targetWords, params.level)

  // 先落诊断再抛错：下面三道门任意一道拦下都要能归因。
  // 旧实现把这一块放在 B 门之前、A 门之后，结果 A 门的失败样本一直没有门禁数字。
  diag.known = {
    knownWords: known.knownWords,
    minKnown,
    personalWords,
    finalMode,
    unknownBudget,
  }

  if (params.targetWords > maxTargetWords) {
    // hard 档 601–1000 是「最终模式」的地盘：没解锁报 400 final_mode_locked（去加词），
    // 而不是 target_words_cap（去缩短）——两者用户要做的事完全不同。
    if (overrideMax === null && params.level === 'hard' && !finalModeUnlocked) {
      throw finalModeLocked({
        targetWords: params.targetWords,
        available: personalWords,
        unlockAt: FINAL_MODE_PERSONAL_WORDS,
      })
    }

    throw targetWordsTooLong({
      level: params.level,
      targetWords: params.targetWords,
      maxTargetWords,
      // 「已解锁」只对 hard 有意义：easy 用户就算攒了 5000 词，能做的也是提高难度
      finalModeUnlocked: params.level === 'hard' && finalModeUnlocked,
    })
  }

  if (minKnown > 0 && known.knownWords < minKnown && !config.skipKnownWordsGate) {
    logger.warn(
      {
        level: params.level,
        targetWords: params.targetWords,
        knownWords: known.knownWords,
        minKnown,
        personalBasicSize: personalBasicWords.length,
        learnedWords: words.length,
      },
      'reading generate rejected: known words below length floor',
    )
    throw knownWordsBelowLength({
      level: params.level,
      targetWords: params.targetWords,
      required: minKnown,
      available: known.knownWords,
    })
  }

  const selection = selectVocabularyPool({
    words,
    level: params.level,
    scope: params.vocabScope,
    targetWords: params.targetWords,
  })

  // 先记选池结果再判够不够：VOCABULARY_TOO_SMALL 恰恰最需要这组数字
  diag.selection = {
    scope: selection.scope,
    available: selection.available,
    poolSize: selection.poolSize,
    requiredWords: selection.requiredWords,
  }

  // A 门：候选池装不下本次篇幅所需的目标词。调一次模型要几秒和几千 token，
  // 按当前参数注定凑不齐就不该发出去。
  //
  // 最终模式跳过：它根本不挑目标词（`selectTargets: false`），池子够不够与成文无关。
  if (!finalMode && !selection.sufficient) {
    logger.warn(
      {
        level: params.level,
        targetWords: params.targetWords,
        scope: selection.scope,
        requiredWords: selection.requiredWords,
        neededVocab: selection.neededVocab,
        available: selection.available,
      },
      'reading generate rejected: VOCABULARY_TOO_SMALL',
    )
    throw vocabularyTooSmall({
      required: selection.neededVocab,
      available: selection.available,
      requiredWords: selection.requiredWords,
      targetWords: params.targetWords,
      scope: selection.scope,
      level: params.level,
    })
  }

  // B 门（`requiredKnown` = 1000 / 1900 / 3778）已于 md/30 §7 删除，
  // 由上面的 `minKnownFor(N)` 取代。`SKIP_KNOWN_WORDS_GATE` 保留给采样。

  const plan = buildTargetPlan({
    pool: selection.pool,
    level: params.level,
    targetWords: params.targetWords,
    // 最终模式不挑目标词：1000 词里塞 100 个必用词只会写成凑词练习
    selectTargets: !finalMode,
  })

  // 篇幅口径：目标 ×1.1、上限 ×1.15，提示词、校验、DTO 全从这里取
  const range = planWordRange(params.targetWords)

  // vocabularySnapshot 的语义变了：不再是「最新 800 个词」，而是「本次选出的候选池」。
  // 老文章存的是前者，两者都只是快照，不影响回放。
  const vocabularySnapshot = selection.pool

  // 提示词词表与校验词表故意不同：
  //   提示词只列候选池 —— 聚焦「这次要复习哪些词」；
  //   校验放行用户全部已学词 —— 模型偶尔会用上池外、但用户确实认识的词。
  //
  // 实测（hard / 200，词库 1177）：候选池封顶 800，被截掉的 377 个恰好是
  // **最简单**的那批（hard 按排名倒序取，留下的全是难的），而它们正是写作时
  // 最顺手的词。首批违规里 serious / hospital / pressure / lamp 全在这一批里。
  // 把这些判成"表外"，等于让选池策略自己制造失败。
  //
  // 日历词单独放行：COCA 源里没有它们，既进不了基础词表也搜不到（见 calendar-words.js）
  // 缩写同理：dr / usa 这类是「词的简写」，词典和基础词表都不收（见 abbreviations.js）
  const learnedWords = words.map((item) => item.word)
  const allowedWords = new Set([
    ...learnedWords,
    ...personalBasicWords,
    ...calendarWords,
    ...ABBREVIATION_WORDS,
  ])

  // 提示词里的词数（池）与校验放行的词数（全部已学词）不是一回事，都记下来；
  // 失败样本里缺了这两个数，就没法判断是「没给模型这个词」还是「给了没用」
  const promptWordCount = selection.poolSize + personalBasicWords.length + calendarWords.length
  diag.allowedWordCount = allowedWords.size
  diag.promptWordCount = promptWordCount

  logger.info(
    {
      level: params.level,
      targetWords: params.targetWords,
      wordRange: range.label,
      scope: selection.scope,
      available: selection.available,
      poolSize: selection.poolSize,
      promptWordCount,
      allowedWordCount: allowedWords.size,
      requiredWords: plan.requiredWords,
      focusCount: plan.focusWords.length,
      // 最终模式下 requiredWords/focusCount 恒为 0，只看这两个数会以为选池坏了
      finalMode,
      minKnown,
      personalWords,
    },
    'vocabulary pool selected',
  )

  // ——— 生成：两条路径共用后面的终检、落库与曝光回写 ———
  //
  //   segmented —— 规划 → 并发分段闭环 → 收尾（默认，md/21 W4）
  //   whole     —— 一次性整篇生成 + 整篇修正（旧路径，A/B 与问题定位用）
  //
  // 分段路径不做整篇修正：全文由「每一段都已通过校验」的段落拼成，
  // 再整篇重写等于把闭环的保证扔掉。
  let content = ''
  let state
  let finishReason = null
  let segmentStats = null
  let segmentRepairCount = 0

  // 整篇路径的修正额度，分段路径保持 0
  let contentRounds = 0
  let lengthRounds = 0
  let expandRounds = 0
  // 分段路径的题目修正轮（md/21 W11 缺口 1）：独立计数，只允许 1 次
  let questionsRounds = 0

  if (config.generationStrategy === 'segmented') {
    const systemPrompt = buildSegmentedSystem({
      level: params.level,
      targetWords: params.targetWords,
      basicWords: personalBasicWords,
      focusWords: plan.focusWords,
      targetWordList: plan.targetWords,
      supportWords: plan.supportWords,
      freeForm: finalMode,
    })

    const segmentCount = planSegmentCount(params.targetWords)
    const planResponse = await callModel({
      kind: 'plan',
      messages: buildPlanMessages(systemPrompt, { segmentCount, range }),
      signal,
      rounds,
      temperature: config.segmentTemperature,
    })

    // 计划不合法由代码补齐（md/20 §5.3），不为此再调一次模型
    const segments = buildSegmentPlan({
      raw: parseAiContent(planResponse.content),
      targetWords: params.targetWords,
      targetWordList: [...plan.focusWords, ...plan.targetWords],
      range,
    })
    diag.segments = segments.map(({ id, goal, maxWords, mustUse }) => ({
      id,
      goal,
      maxWords,
      mustUseCount: mustUse.length,
    }))

    const names = new Set()
    const generated = await generateSegmented({
      segments,
      systemPrompt,
      allowedWords,
      names,
      signal,
      rounds,
      questionCount: params.questionCount,
      range,
      // 收尾生成题目时要按难度执行题型配额（W7）
      level: params.level,
    })

    segmentStats = generated.stats
    segmentRepairCount = generated.repairCount
    finishReason = generated.finishReason

    // 分段里认出的专有名词不在收尾的 names 里（names 只存前 3 个），
    // 但它们确实出现在正文里，必须参与全文校验，否则会被判成表外词
    for (const name of generated.detectedNames) allowedWords.add(name)

    const segmentedContent = JSON.stringify(generated.data)
    content = segmentedContent
    diag.content = segmentedContent
    state = evaluate({ content, params, allowedWords, range, unknownBudget })

    // 分段路径没有整篇修正循环，但题目是收尾单独产出的（md/21 W11 缺口 1）：
    // 正文、标题、翻译、names 都已经过段级与全文校验，题目不合格时只重出题目，
    // 与整篇路径的 `questions` 轮同口径。只给 1 次，再不合格交给下面的终检报 502。
    if (state.feedback?.type === 'questions') {
      logger.warn(
        { round: questionsRounds + 1, type: 'questions', reason: state.feedback.reason },
        'reading repair round',
      )

      const repairMessages = buildRepairMessages(
        buildFinishMessages(systemPrompt, {
          article: generated.data.article,
          questionCount: params.questionCount,
          paragraphCount: segmentStats.filter((item) => item.accepted).length,
          level: params.level,
        }),
        state.feedback,
        content,
        params.level,
      )

      const repaired = await callModel({
        kind: 'repair',
        repairFor: 'questions',
        messages: repairMessages,
        signal,
        rounds,
      })

      // 收尾的 JSON 里没有 article（正文是分段拼出来的），不能直接拿它当整篇校验。
      // 只取题目，其余字段用已经通过校验的原值；解析失败则保留原始输出，
      // 让 evaluate() 按结构不合法处理（与 whole 的 questions 轮同一个出口）。
      const repairedQuestions = parseAiContent(repaired.content)?.questions
      content =
        Array.isArray(repairedQuestions) && repairedQuestions.length
          ? JSON.stringify({ ...generated.data, questions: repairedQuestions })
          : repaired.content
      finishReason = repaired.finishReason ?? finishReason
      diag.content = content
      questionsRounds += 1
      state = evaluate({ content, params, allowedWords, range, unknownBudget })
      recordRound({ rounds, state, content, diag })
    }

    logger.info(
      {
        strategy: 'segmented',
        segments: segmentStats.length,
        accepted: segmentStats.filter((item) => item.accepted).length,
        segmentRepairCount,
        finishReason,
      },
      'segmented generation finished',
    )
  } else {
    const messages = buildMessages({
      level: params.level,
      targetWords: params.targetWords,
      questionCount: params.questionCount,
      focusWords: plan.focusWords,
      targetWordList: plan.targetWords,
      supportWords: plan.supportWords,
      basicWords: personalBasicWords,
      freeForm: finalMode,
    })

    const first = await callModel({ kind: 'generate', messages, signal, rounds })

    content = first.content
    finishReason = first.finishReason
    state = evaluate({ content, params, allowedWords, range, unknownBudget })
    recordRound({ rounds, state, content, diag })

    // 修正轮分三种额度：
    //   content —— 结构 / 用词，默认 2 轮（发生过重写时 +1）
    //   length  —— 篇幅重写（超长），默认 1 轮
    //   expand  —— 扩写（偏短），默认 **0** 轮（md/21 W6）
    // 原来 content/length 共用 maxRepairRounds，实测「先用词后压缩」时压缩只剩一次机会，
    // 253 词只删到 239。分开计数后每种问题总有独立的一次机会。
    // 最坏 1 生成 + 2 用词 + 1 重写 + 1 用词 = 5 次调用（默认配置下 expand=0，不开扩写）。
    // 每一轮都重新完整判断一次，避免旧实现里「上一轮的 feedback 没被更新」。
    while (state.feedback) {
      const isLength = state.feedback.type === 'word_count'
      const isExpand = state.feedback.type === 'word_expand'
      // 重写是「重新编故事」，实测会带出十几个表外词。发生过重写时多给一轮
      // 用词修正，避免「压短了但满篇生词 → 422」这种比超长更糟的结果。
      const contentBudget = config.maxRepairRounds + (lengthRounds > 0 ? 1 : 0)
      const budgetLeft = isLength
        ? lengthRounds < config.maxLengthRounds
        : isExpand
          ? expandRounds < config.maxExpandRounds
          : contentRounds < contentBudget
      if (!budgetLeft) break

      if (isLength) lengthRounds += 1
      else if (isExpand) expandRounds += 1
      else contentRounds += 1

      const round = contentRounds + lengthRounds + expandRounds
      logger.warn(
        {
          round,
          type: state.feedback.type,
          reason: state.feedback.reason,
          violations: state.feedback.violations,
          actualWords: state.feedback.actualWords,
          ...describeContent(content),
          finishReason,
        },
        'reading repair round',
      )

      // 结构合法时把它自己的输出放回上下文；结构不合法时不放，避免把半截 JSON
      // 当成"自己的话"喂回去，反而诱导模型照抄。
      // questions 例外：JSON 是好的，只是题目不合格，正需要它看着正文改题。
      const previous =
        state.result.ok || state.feedback.type === 'questions' ? content : ''
      const repaired = await callModel({
        kind: 'repair',
        // 记下这一轮是被什么催出来的，和它自己又判出什么分开存
        repairFor: state.feedback.type,
        // 扩写与原稿是同一篇：带上一篇正文当锚点；压缩必须不带（见 buildRepairMessages）
        messages: isExpand
          ? buildExpandMessages(messages, state.feedback, previous, params.level)
          : buildRepairMessages(messages, state.feedback, previous, params.level),
        signal,
        rounds,
      })

      content = repaired.content
      finishReason = repaired.finishReason ?? finishReason
      state = evaluate({ content, params, allowedWords, range, unknownBudget })
      recordRound({ rounds, state, content, diag })

      // 模型主动认输时再修也没用，跳出去交给下面的统一处理
      if (state.result.insufficient) break
    }
  }

  // 分段路径的「修正」是段内重写，与整篇修正分开计数但对外同口径
  const repairRounds =
    contentRounds + lengthRounds + expandRounds + questionsRounds + segmentRepairCount
  const tokenUsage = sumUsage(rounds)
  // 后面的三条 throw 都在预算耗尽之后，这两个数要让它们能看见
  diag.repairRounds = repairRounds
  diag.totalTokens = tokenUsage.totalTokens

  if (state.result.insufficient) {
    logger.warn(
      { ...describeContent(content), finishReason, repairRounds, tokenUsage },
      'reading generate failed: model reported INSUFFICIENT_VOCABULARY',
    )
    throw insufficientVocabularyError()
  }

  if (!state.result.ok) {
    logger.warn(
      { reason: state.result.reason, ...describeContent(content), finishReason, repairRounds },
      'reading generate failed: AI_INVALID_RESPONSE',
    )
    throw new ApiError(
      502,
      ERROR_CODES.AI_INVALID_RESPONSE,
      'AI 返回结构不合法，请稍后重试。',
    )
  }

  const data = state.result.data
  const actualWords = countWords(data.article)

  // 难度客观化（W7）：六项纯代码指标加权成 0–100 分。
  // 只记录、不设闸门——先让每次生成都留下分数，阈值等采样之后再定，
  // 否则「按现在的成功率反推阈值」等于让数据迁就实现。
  const difficulty = measureDifficulty(data.article)

  // 目标词真实覆盖度（W5）：只记录 + warn，不触发修复。
  // 修复要多一轮调用，先用采样数据确认「覆盖率低」真的值得修（md/21 W5）。
  const targetUsage = measureTargetCoverage({
    article: data.article,
    focusWords: plan.focusWords,
    targetWords: plan.targetWords,
    requiredWords: plan.requiredWords,
  })
  const unusedTargetWords = targetUsage.unused

  // 最终模式没有目标词，requiredWords = 0 时 coverageRate 恒为 0（0/0 的约定），
  // 不判一下这篇长文每次生成都会留一条假告警，把真告警淹掉。
  if (!finalMode && targetUsage.coverageRate < TARGET_COVERAGE_ALERT) {
    logger.warn(
      { ...targetUsage, strategy: config.generationStrategy, level: params.level },
      'target coverage below threshold (warn only, md/21 W5)',
    )
  }

  // 篇幅额度用尽后仍然超长时，evaluate() 停在 word_count 分支就返回了，没跑词汇校验。
  // 超长本身照旧放行（界面展示真实词数），但生词必须查出来：否则 unknownWords
  // 恒为空，库里最"干净"的那批文章恰恰是没查过的（§6.8）。
  // 这里只补诊断：不追加模型调用、不占额度、也不因此判 422。
  const lateVocabulary = !state.vocabulary
  if (lateVocabulary) {
    state.vocabulary = validateArticle({
      article: data.article,
      allowedWords,
      names: data.names,
    })
    // 补查的是最后一轮的原文，结果就落到这一轮上；中间那些被丢弃的超长轮次
    // 保持 undefined——它们确实没查过，补写会把统计口径弄回去
    const last = rounds.at(-1)
    if (last) {
      last.unknownWords = state.vocabulary.unknownWords
      last.counts = state.vocabulary.counts
    }
    diag.state = state
  }

  const unknownWords = state.vocabulary.unknownWords

  // evaluate() 已经保证不超过额度，这里是防御：任何路径下都不该写出满篇生词。
  // 唯一的例外是上面补查的超长文章：它已经没有额度可用了，再拦下来等于白白烧掉
  // 几次调用，只记日志，让「超长 + 生词超标」在日志和 aiMeta 里都看得见。
  if (unknownWords.length > unknownBudget && !lateVocabulary) {
    logger.warn(
      {
        violations: state.vocabulary.violations.slice(0, 20),
        violationCount: unknownWords.length,
        actualWords,
        finishReason,
        repairRounds,
      },
      'reading generate failed: VOCABULARY_VALIDATION_FAILED',
    )
    throw new ApiError(
      422,
      ERROR_CODES.VOCABULARY_VALIDATION_FAILED,
      `文章使用了 ${unknownWords.length} 个不在词汇表内的单词：${unknownWords.slice(0, 5).join('、')}`,
    )
  }

  if (lateVocabulary && unknownWords.length > unknownBudget) {
    logger.warn(
      {
        violations: state.vocabulary.violations.slice(0, 20),
        violationCount: unknownWords.length,
        actualWords,
        finishReason,
        repairRounds,
      },
      'over-length article accepted with too many unknown words',
    )
  }

  // 放行的未学词：带着音标与释义回给前端做折叠提示
  const newWords = unknownWords.map(describeNewWord)
  const deviation = Number((actualWords / params.targetWords).toFixed(3))

  // 超出 ±15% 不判失败：界面展示真实词数，用户自己能判断。
  // 验收下界比提示词下界低（200 词请求允许 170），因为重写天然偏短。
  // 三态（W6）落库 + 告警；偏短的扩写由 MAX_EXPAND_ROUNDS 控制，默认关闭。
  const accepted = planAcceptedRange(params.targetWords)
  const lengthStatus = classifyLength(actualWords, accepted)
  if (lengthStatus !== 'ok') {
    logger.warn(
      { actualWords, acceptedRange: accepted.label, lengthStatus, repairRounds },
      'article outside accepted word range',
    )
  }

  logger.info(
    {
      actualWords,
      targetWords: params.targetWords,
      wordRange: range.label,
      deviation,
      lengthStatus,
      unknownWordCount: newWords.length,
      // W5：一行摘要，采样报告直接读日志也能看到覆盖度
      coverageRate: targetUsage.coverageRate,
      densityScore: targetUsage.densityScore,
      // W7：同一档难度的文章，分数应该聚在一起；分布散了说明档位只是个标签
      difficultyScore: difficulty.score,
      // true = 篇幅额度耗尽后补查的用词，这批文章的违规数以前是假的 0
      lateVocabulary,
      finishReason,
      repairRounds,
      tokenUsage,
    },
    'reading generated',
  )

  const doc = await repo.create({
    userId,
    title: data.title,
    article: data.article,
    translation: data.translation,
    level: params.level,
    targetWords: params.targetWords,
    questionCount: params.questionCount,
    actualWords,
    questions: data.questions,
    vocabularySnapshot,
    newWords,
    targetPlan: {
      scope: selection.scope,
      poolSize: selection.poolSize,
      requiredWords: plan.requiredWords,
      focusWords: plan.focusWords,
      unused: unusedTargetWords,
    },
    names: data.names,
    status: 'generated',
    aiMeta: {
      model: config.deepseekModel,
      // 哪条路径产出的：跨策略采样不能混在一起比（md/21 W4）
      strategy: config.generationStrategy,
      // 分段明细：哪一段重写了几次、是否被丢弃。整篇路径为空数组
      segments: segmentStats ?? [],
      // 词表与代码的版本号：跨版本采样不能放在一起比。
      // 基础词表按档记——只记一个 hash 会掩盖「easy 没变、medium 变了」
      basicWordsVersion: basicWordsVersions.easy,
      basicWordsLevel: params.level,
      // W8：门禁数字随文章留下，报告里才能回答「这篇为什么能过」
      knownWords: known.knownWords,
      // 篇幅对应的最低已知词量（md/30 §7.2），取代按难度写死的 requiredKnown
      minKnown,
      personalWords,
      // true = 最终模式（hard + > 600 词 + 个人词库 ≥ 3000），没有目标词
      finalMode,
      // true = 这篇是在跳过 B 门的采样实例上跑出来的（md/27 阶段二）。
      // 它与线上样本不可比，报表/回归必须能一眼区分开。
      knownGateSkipped: config.skipKnownWordsGate,
      unknownBudget,
      irregularFormsVersion,
      codeVersion,
      // 累计值，含所有修正轮——用户看到的「本次消耗 N tokens」就是它
      ...tokenUsage,
      rounds,
      maxTokens: config.maxOutputTokens,
      repairRounds,
      finishReason,
      violationsCount: newWords.length,
      wordCountDeviation: deviation,
      // W6：ok / short / long。short 默认只记录，开了 MAX_EXPAND_ROUNDS 才会补写
      lengthStatus,
      candidatePoolSize: selection.poolSize,
      requiredWords: plan.requiredWords,
      // W5：六项覆盖度指标。只记录（M2），不参与重试判断
      targetUsage,
      // W7：难度分数 + 六项原始指标。同样是只记录，用来核对「档位」和「实际难度」是否一致
      difficulty,
    },
  })

  // 曝光回写：文章生成了，就不该再被 today_new / 复习优先级当成「没见过」。
  // 统计失败只记日志，绝不影响已经生成好的文章——和 recordFailure 同一原则。
  try {
    await wordRepository.markExposure({
      userId,
      words: pickUsedWords(learnedWords, data.article),
      at: new Date(),
    })
  } catch (error) {
    logger.error({ err: error, userId }, 'reading generate: markExposure failed')
  }

  return toSafeDto(doc)
}

/**
 * GET /api/readings/capacity
 *
 * 生成前的预检：前端据此禁用做不到的难度，并显示「还需 N 个单词解锁」。
 *
 * md/30 §7 之后每档回四组数：
 *   A 目标词门    required / sufficient / shortage（scope 相关，缩篇幅可解）
 *   篇幅门槛      knownWords / personalWords / minKnown / maxTargetWords / targetWordsAllowed
 *   解锁状态      finalMode { unlocked, unlockAt, shortage }
 *   篇幅阶梯      lengths[]（100–1000 每 100 词一行，带 blockedBy）
 *
 * 前端「能不能点」= `targetWordsAllowed && (本次是否最终模式 ? finalMode.unlocked : lengths 里对应行 unlocked)`
 * ——但是简单起见，直接用 `levels[level].lengths` 里 `targetWords` 那一行的 `unlocked` 就够了，
 * 它已经把三道门合并成一个布尔值。
 *
 * 与 generate 读同一份 `capacity-table.js` / `selectVocabularyPool` / `measureKnownVocabulary`，
 * 预检数字与真实闸门不会分叉。代价是要把用户词表读进内存；单用户、万词量级足够，
 * 破 2 万再改聚合计数。
 */
export async function getCapacity({ userId, query }) {
  const { targetWords, vocabScope } = parseOrThrow(capacityQuerySchema, query)
  const words = await wordRepository.findVocabulary(userId)
  const removedBasicWords = (await wordRepository.findNewWords(userId)).map((item) => item.word)
  const learnedWords = words.map((item) => item.word)
  const range = planWordRange(targetWords)

  // 解锁口径：个人词库条数（learning + mastered），与生成里 countVocabulary 同源
  const personalWords = words.length
  const finalModeUnlocked = isFinalModeUnlocked({ personalWords })
  const unlockAt = FINAL_MODE_PERSONAL_WORDS
  const unlockShortage = Math.max(0, unlockAt - personalWords)

  const levels = {}
  // 兼容字段：循环结束后留下来的是最后一档（hard）的池子大小。
  // 新代码一律读 levels[level].available——难度不同，池子本来就不是一个数
  let available = 0
  let knownWords = 0

  for (const level of LEVELS) {
    const selection = selectVocabularyPool({ words, level, scope: vocabScope, targetWords })
    // 与 generateReadingInner 调的是同一个函数，预检数字和真实闸门不会分叉
    const known = measureKnownVocabulary({ level, learnedWords, removedBasicWords })
    const ladder = lengthLadder({ level, knownWords: known.knownWords, personalWords })
    // 采样实例（MAX_TARGET_WORDS）按同一个覆盖值报，否则预检与生成对不上
    const maxTargetWords = Number.isInteger(config.maxTargetWordsOverride)
      ? config.maxTargetWordsOverride
      : maxTargetWordsFor(level, personalWords)
    // 本次请求是不是最终模式：hard + > 600 + 已解锁
    const finalMode = isFinalMode({ level, targetWords, personalWords })
    const minKnown = finalMode ? 0 : minKnownFor(targetWords, level)

    available = selection.available
    knownWords = known.knownWords
    levels[level] = {
      // A 目标词门：这次参数凑不齐目标词，缩篇幅 / 换词源可解。
      // 最终模式不挑目标词，这道门不存在——报 0 / true，免得前端显示「还差 100 个」
      required: finalMode ? 0 : selection.neededVocab,
      sufficient: finalMode ? true : selection.sufficient,
      shortage: finalMode ? 0 : Math.max(0, selection.neededVocab - selection.available),
      // 每档各自的候选池大小（English_vue/md/13 B1）：
      // 顶层 available 是循环里最后一次赋值的 hard 口径，easy 的池子更小，
      // 用 hard 的数字解释 easy 说「不够」，用户会觉得系统在骗人
      available: selection.available,
      // 篇幅门槛（md/30 §7.2）：写 targetWords 词至少要认识 minKnown 个
      knownWords: known.knownWords,
      personalWords,
      minKnown,
      unknownBudget: unknownBudgetFor(level, config.maxUnknownWordsOverride),
      maxTargetWords,
      targetWordsAllowed: targetWords <= maxTargetWords,
      // 解锁状态。`supported` 标明这一档有没有最终模式（只有 hard 有），
      // 前端不必把 "hard" 写进页面逻辑。
      finalMode: {
        supported: level === 'hard',
        unlocked: finalModeUnlocked,
        unlockAt,
        shortage: unlockShortage,
        active: finalMode,
      },
      // 篇幅阶梯：按难度算，所以挂在档下面而不是顶层（md/30 §7.5 偏离记录）
      lengths: ladder,
    }
  }

  return {
    targetWords,
    // wordRange = 生成时提示词要求的区间；acceptedRange = 验收口径（±15%）
    wordRange: range,
    acceptedRange: planAcceptedRange(targetWords),
    available,
    // 三个顶层汇总字段：与 personalWords 并排放，前端能看到「已知词 3180 / 个人词库 2562」
    knownWords,
    personalWords,
    finalMode: {
      unlocked: finalModeUnlocked,
      unlockAt,
      shortage: unlockShortage,
      maxTargetWords: FINAL_MODE_MAX_WORDS,
    },
    levels,
  }
}

/** answers 的格式错误统一用 INVALID_ANSWER，前端据此提示"答案格式不对" */
function parseAnswers(body) {
  const result = submitReadingSchema.safeParse(body)

  if (result.success) return result.data.answers

  throw new ApiError(
    400,
    ERROR_CODES.INVALID_ANSWER,
    result.error.issues[0].message,
    'answers',
  )
}

/**
 * POST /api/readings/:id/submit
 *
 * 1. 校验答案数组的结构
 * 2. 取文档，确认 questionId 都属于这份练习
 * 3. 用库里的 correctAnswer 判分（绝不信客户端）
 * 4. 条件更新 generated → submitted，并发的第二个请求拿 409
 */
export async function submitReading({ userId, id, body }) {
  const answers = parseAnswers(body)

  // 非法 ObjectId 直接当 404，否则 Mongoose 会抛 CastError 变成 500
  if (!mongoose.isValidObjectId(id)) throw readingNotFound()

  const reading = await repo.findByIdAndUser(id, userId)
  if (!reading) throw readingNotFound()

  const questions = new Map(reading.questions.map((item) => [item.id, item]))
  const userAnswers = {}

  for (const { questionId, selectedOption } of answers) {
    const question = questions.get(questionId)
    if (!question) {
      throw new ApiError(
        400,
        ERROR_CODES.INVALID_ANSWER,
        `题目 ${questionId} 不属于这份练习`,
        'answers',
      )
    }

    if (selectedOption !== null && selectedOption >= question.options.length) {
      throw new ApiError(
        400,
        ERROR_CODES.INVALID_ANSWER,
        `题目 ${questionId} 的选项越界`,
        'answers',
      )
    }

    // 未作答不落库：Map 的 of: Number 存 null 会走类型转换，容易埋坑
    if (selectedOption !== null) userAnswers[questionId] = selectedOption
  }

  const totalQuestions = reading.questions.length
  const correctCount = reading.questions.reduce(
    (sum, question) => sum + (userAnswers[question.id] === question.correctAnswer ? 1 : 0),
    0,
  )
  const score = totalQuestions ? Math.round((correctCount / totalQuestions) * 100) : 0

  const updated = await repo.submitIfGenerated(id, userId, {
    status: 'submitted',
    userAnswers,
    score,
    correctCount,
    submittedAt: new Date(),
  })

  if (!updated) {
    // 没更新到只有两种可能：记录没了，或已经提交过
    const exists = await repo.existsByIdAndUser(id, userId)
    if (!exists) throw readingNotFound()

    throw conflict(ERROR_CODES.ALREADY_SUBMITTED, '这份练习已提交过')
  }

  // 复习回写：只在 vocabScope 里「本篇候选池」中的词才记账。
  // 不能拿整库取交集——the / is 这类词每篇都有，写进去等于把 today_reviewed 泡成第二份全库。
  // submitIfGenerated 已经保证只有第一次提交能走到这里，重复提交不会二次写时间。
  try {
    const usedWords = pickUsedWords(updated.vocabularySnapshot ?? [], updated.article)
    await wordRepository.markReviewed({
      userId,
      words: usedWords,
      at: updated.submittedAt ?? new Date(),
    })
  } catch (error) {
    logger.error({ err: error, userId, id }, 'reading submit: markReviewed failed')
  }

  return toResultDto(updated)
}

/**
 * GET /api/readings/:id
 *
 * 两个分支：
 *   generated → 安全 DTO（不含翻译与答案），刷新答题页可以继续作答
 *   submitted → 完整结果（含翻译与解析），刷新结果页不丢内容
 */
export async function getReading({ userId, id }) {
  if (!mongoose.isValidObjectId(id)) throw readingNotFound()

  const doc = await repo.findByIdAndUser(id, userId)
  if (!doc) throw readingNotFound()

  return doc.status === 'submitted' ? toResultDto(doc) : toSafeDto(doc)
}

/**
 * GET /api/readings/history
 *
 * 口径（全部接口里最容易做错的一条）：
 *   stats —— 只统计已提交、且**不受 level 筛选影响**
 *   total / items —— 受 level 筛选影响
 * 筛选之后 stats 必须纹丝不动，否则统计卡片会跟着筛选跳动。
 */
export async function listHistory({ userId, query }) {
  const level = HISTORY_LEVEL_FILTERS.includes(query.level) ? query.level : 'all'
  const { page, pageSize } = query

  const total = await repo.countHistory({ userId, level })
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, lastPage)

  const items =
    total === 0
      ? []
      : await repo.findHistoryPage({
          userId,
          level,
          skip: (currentPage - 1) * pageSize,
          limit: pageSize,
        })

  const [row] = await repo.statsByUser(userId)
  const totalCount = row?.totalCount ?? 0
  const stats = {
    totalCount,
    averageAccuracy: totalCount ? Math.round(row.scoreSum / totalCount) : 0,
    bestScore: row?.bestScore ?? 0,
    totalWordsRead: row?.totalWordsRead ?? 0,
  }

  return {
    items: items.map(toHistoryItem),
    total,
    page: currentPage,
    pageSize,
    stats,
  }
}
