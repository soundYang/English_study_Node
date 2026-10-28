import mongoose from 'mongoose'

import { config } from '../../config/index.js'
import {
  ApiError,
  ERROR_CODES,
  conflict,
  knownWordsTooSmall,
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
  buildMessages,
  buildPlanMessages,
  buildRepairMessages,
  buildSegmentedSystem,
} from './ai.prompt.js'
import { parseAiContent, validateAiReading } from './ai.schema.js'
import { ignoredFunctionWordRemovals } from './basic-words.js'
import { calendarWords } from './calendar-words.js'
import { limitOf, measureKnownVocabulary, unknownBudgetFor } from './level-limits.js'
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
 *   feedback: null | { type: 'structure'|'vocabulary'|'word_count'|'word_expand', reason: string, violations?: Array, actualWords?: number, range?: object },
 * }}
 */
function evaluate({ content, params, allowedWords, range, unknownBudget }) {
  const result = inspect(content, params)

  if (result.insufficient) return { result, feedback: null }
  if (!result.ok) {
    // 结构不合法时全文重写，顺便把篇幅区间重申一遍
    return { result, feedback: { type: 'structure', reason: result.reason, range } }
  }

  // 每轮都数一次：写进 rounds[]，调篇幅策略时能看出「首轮 290 → 重写 228」
  const actualWords = countWords(result.data.article)
  const acceptedRange = planAcceptedRange(params.targetWords)

  // 篇幅优先于用词：实测用词修正会稳定把文章改长（231→234、277→279），
  // 先修词等于把超长的问题放大。先重写成目标篇幅，篇幅短了带出的高级词也少。
  if (actualWords > range.max) {
    return {
      result,
      actualWords,
      feedback: {
        type: 'word_count',
        actualWords,
        range,
        reason: `正文有 ${actualWords} 个英文单词，超过上限 ${range.max}`,
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
    // W3 的门禁数字：失败样本多数正是死在这三道门上，不记就没法归因
    knownWords: diag.known?.knownWords,
    requiredKnown: diag.known?.requiredKnown,
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
 * 闸门顺序不能换（md/20 §2.1、md/21 W3）：
 *   0. 篇幅超过该难度上限 → 400 INVALID_REQUEST（纯参数错，不读库）
 *   1. 词数 < 20 → 422 INSUFFICIENT_VOCABULARY
 *   2. 候选池装不下本次篇幅 → 422 VOCABULARY_TOO_SMALL（kind=target_words）
 *   3. 已知词汇量低于该难度下限 → 422 VOCABULARY_TOO_SMALL（kind=known_words）
 * 2 说的是「这次参数凑不齐」，3 说的是「这个难度还没准备好」；先报成本更低的解法
 * （缩篇幅 / 换词源），再报加词或降难度。每一道都在调模型之前，判定与 /capacity 共用同一套函数。
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

  // 篇幅上限跟难度走（md/20 §2.2）。放在读库之前——这是纯参数判定，
  // 和「词汇量为 0 也先报参数错」是同一个约定。
  const limit = limitOf(params.level)
  if (params.targetWords > limit.maxTargetWords) {
    throw targetWordsTooLong({
      level: params.level,
      targetWords: params.targetWords,
      maxTargetWords: limit.maxTargetWords,
    })
  }

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

  // B 门要用的已知词汇量；顺便拿到扣掉 new 词之后的个人基础词
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
    version: basicWordsVersions[params.level],
  }
  diag.known = {
    knownWords: known.knownWords,
    requiredKnown: known.requiredKnown,
    unknownBudget,
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

  // 池子装不下就必须拦在这里：调一次模型要几秒和几千 token，
  // 而按当前参数注定凑不出目标词数。
  if (!selection.sufficient) {
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

  // B 门：已知词汇量（md/20 §2.1）。
  //
  // 放在 A 门之后是有意的：A 门说「这次参数凑不齐目标词」，缩短篇幅或换词源就能过；
  // B 门说「这个难度你还没准备好」，只有加词或降难度能过。先报成本更低的解法。
  // 两道都在调模型之前——一次调用几秒、几千 token，注定失败就不该发出去。
  if (!known.sufficient) {
    logger.warn(
      {
        level: params.level,
        targetWords: params.targetWords,
        knownWords: known.knownWords,
        requiredKnown: known.requiredKnown,
        personalBasicSize: personalBasicWords.length,
        learnedWords: words.length,
      },
      'reading generate rejected: known words below level floor',
    )
    throw knownWordsTooSmall({
      level: params.level,
      required: known.requiredKnown,
      available: known.knownWords,
    })
  }

  const plan = buildTargetPlan({
    pool: selection.pool,
    level: params.level,
    targetWords: params.targetWords,
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

  if (config.generationStrategy === 'segmented') {
    const systemPrompt = buildSegmentedSystem({
      level: params.level,
      targetWords: params.targetWords,
      basicWords: personalBasicWords,
      focusWords: plan.focusWords,
      targetWordList: plan.targetWords,
      supportWords: plan.supportWords,
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
      const previous = state.result.ok ? content : ''
      const repaired = await callModel({
        kind: 'repair',
        // 记下这一轮是被什么催出来的，和它自己又判出什么分开存
        repairFor: state.feedback.type,
        // 扩写与原稿是同一篇：带上一篇正文当锚点；压缩必须不带（见 buildRepairMessages）
        messages: isExpand
          ? buildExpandMessages(messages, state.feedback, previous)
          : buildRepairMessages(messages, state.feedback, previous),
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
  const repairRounds = contentRounds + lengthRounds + expandRounds + segmentRepairCount
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

  // 目标词真实覆盖度（W5）：只记录 + warn，不触发修复。
  // 修复要多一轮调用，先用采样数据确认「覆盖率低」真的值得修（md/21 W5）。
  const targetUsage = measureTargetCoverage({
    article: data.article,
    focusWords: plan.focusWords,
    targetWords: plan.targetWords,
    requiredWords: plan.requiredWords,
  })
  const unusedTargetWords = targetUsage.unused

  if (targetUsage.coverageRate < TARGET_COVERAGE_ALERT) {
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
      basicWordsVersion: basicWordsVersions[params.level],
      basicWordsLevel: params.level,
      // W8：门禁数字随文章留下，报告里才能回答「这篇为什么能过」
      knownWords: known.knownWords,
      requiredKnown: known.requiredKnown,
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
 * 三道门禁的数字一次全回：
 *   A 目标词门  required / sufficient / shortage（scope 相关，缩篇幅可解）
 *   B 已知词门  knownWords / requiredKnown / knownSufficient / knownShortage
 *   C 生词预算 + 篇幅上限 unknownBudget / maxTargetWords / targetWordsAllowed
 * 前端「能不能点」= 三个都通过；「还差多少」直接取对应的 shortage。
 *
 * 选池与已知词量分别调用 selectVocabularyPool / measureKnownVocabulary——
 * 和 generate 用的是**同一组函数**，所以预检数字与真实闸门永远一致，
 * 不存在「预检说能、点下去 422」。代价是要把用户词表读进内存；
 * 单用户、万词量级足够，破 2 万再改聚合计数。
 */
export async function getCapacity({ userId, query }) {
  const { targetWords, vocabScope } = parseOrThrow(capacityQuerySchema, query)
  const words = await wordRepository.findVocabulary(userId)
  const removedBasicWords = (await wordRepository.findNewWords(userId)).map((item) => item.word)
  const learnedWords = words.map((item) => item.word)
  const range = planWordRange(targetWords)

  const levels = {}
  let available = 0

  for (const level of LEVELS) {
    const selection = selectVocabularyPool({ words, level, scope: vocabScope, targetWords })
    // 与 generateReadingInner 调的是同一个函数，预检数字和真实闸门不会分叉
    const known = measureKnownVocabulary({ level, learnedWords, removedBasicWords })
    const limit = limitOf(level)

    available = selection.available
    levels[level] = {
      // A 目标词门：这次参数凑不齐目标词，缩篇幅 / 换词源可解
      required: selection.neededVocab,
      sufficient: selection.sufficient,
      shortage: Math.max(0, selection.neededVocab - selection.available),
      // B 已知词门：该难度要求认识多少词，只有加词 / 降难度可解
      knownWords: known.knownWords,
      requiredKnown: known.requiredKnown,
      knownSufficient: known.sufficient,
      knownShortage: known.shortage,
      // C 生词预算，以及该难度允许的篇幅上限（前端滑块的 max）
      unknownBudget: unknownBudgetFor(level, config.maxUnknownWordsOverride),
      maxTargetWords: limit.maxTargetWords,
      targetWordsAllowed: targetWords <= limit.maxTargetWords,
    }
  }

  return {
    targetWords,
    // wordRange = 生成时提示词要求的区间；acceptedRange = 验收口径（±15%）
    wordRange: range,
    acceptedRange: planAcceptedRange(targetWords),
    available,
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
