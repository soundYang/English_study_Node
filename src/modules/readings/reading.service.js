import mongoose from 'mongoose'

import { config } from '../../config/index.js'
import {
  ApiError,
  ERROR_CODES,
  conflict,
  readingNotFound,
  vocabularyTooSmall,
} from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { wordRepository } from '../words/word.repository.js'
import { chatJson } from './ai.client.js'
import { buildMessages, buildRepairMessages } from './ai.prompt.js'
import { parseAiContent, validateAiReading } from './ai.schema.js'
import { basicWords } from './basic-words.js'
import { calendarWords } from './calendar-words.js'
import { toHistoryItem, toResultDto, toSafeDto } from './reading.dto.js'
import { readingRepository as repo } from './reading.repository.js'
import {
  HISTORY_LEVEL_FILTERS,
  generateReadingSchema,
  submitReadingSchema,
} from './reading.schema.js'
import { buildTargetPlan } from './target-plan.js'
import { validateArticle } from './vocabulary.service.js'
import { selectVocabularyPool } from './vocabulary-pool.js'

/**
 * 输出 token 上限。
 *
 * 原来的 2600 是按 300 词上限定的；篇幅放开到 800 词后，英文正文约 1100 token、
 * 中文翻译约 1200 token，加题目和 JSON 结构已超过 2600，必然被截断成
 * AI_INVALID_RESPONSE。取 6000 留足余量（DeepSeek chat 上限 8192）。
 * 这只是上限不是消耗：100 词的请求仍然按 estimateMaxTokens 算出来约 1200。
 */
const MAX_TOKENS_CAP = 6000
/** article 实际词数允许偏离目标的范围，超出只记 warning 不判错 */
const WORD_COUNT_TOLERANCE = { min: 0.7, max: 1.4 }

function countWords(article) {
  return (String(article).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length
}

/** 按 targetWords 估算输出上限，避免写 300 词时被截断 */
function estimateMaxTokens(targetWords) {
  return Math.min(MAX_TOKENS_CAP, 600 + targetWords * 6)
}

async function callModel({ messages, targetWords, signal }) {
  return chatJson({
    messages,
    signal,
    maxTokens: estimateMaxTokens(targetWords),
  })
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
 * 结构通过后检查用词。
 * @returns {{ valid: true } | { valid: false, reason: string, violations: Array }}
 */
function inspectVocabulary(data, allowedWords) {
  const result = validateArticle({
    article: data.article,
    allowedWords,
    names: data.names,
  })

  if (result.valid) return { valid: true }

  return {
    valid: false,
    reason: `使用了 ${result.unknownWords.length} 个不在 allowedWords 中的单词`,
    violations: result.violations,
  }
}

/**
 * POST /api/readings/generate
 *
 * 流程：参数校验 → 词汇量总闸 → 选池（scope + 优先级 + 难度比例）
 *       → 定目标词计划 → 组装允许词汇 → 调模型
 *       → 结构校验 → 词汇校验 →（最多 1 轮修正，结构与词汇共用这一轮）
 *       → 落库 → 返回安全 DTO。
 *
 * 两道闸门顺序不能换：
 *   1. 词数 < 20 → INSUFFICIENT_VOCABULARY（和以前一样，最前面拦）
 *   2. 候选池装不下本次篇幅 → VOCABULARY_TOO_SMALL，**禁止生成**
 * 第 2 道是按「本次参数」算的，所以缩短篇幅或降低难度就能过——提示语要把这个说出来。
 */
export async function generateReading({ userId, body, signal }) {
  const params = parseOrThrow(generateReadingSchema, body)

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
  const selection = selectVocabularyPool({
    words,
    level: params.level,
    scope: params.vocabScope,
    targetWords: params.targetWords,
  })

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

  const plan = buildTargetPlan({
    pool: selection.pool,
    level: params.level,
    targetWords: params.targetWords,
  })

  // vocabularySnapshot 的语义变了：不再是「最新 800 个词」，而是「本次选出的候选池」。
  // 老文章存的是前者，两者都只是快照，不影响回放。
  const vocabularySnapshot = selection.pool

  // 日历词单独放行：COCA 源里没有它们，既进不了基础词表也搜不到（见 calendar-words.js）
  const allowedWords = new Set([
    ...selection.pool,
    ...basicWords,
    ...calendarWords,
  ])

  logger.info(
    {
      level: params.level,
      targetWords: params.targetWords,
      scope: selection.scope,
      available: selection.available,
      poolSize: selection.poolSize,
      requiredWords: plan.requiredWords,
      focusCount: plan.focusWords.length,
    },
    'vocabulary pool selected',
  )

  const messages = buildMessages({
    level: params.level,
    targetWords: params.targetWords,
    questionCount: params.questionCount,
    focusWords: plan.focusWords,
    targetWordList: plan.targetWords,
    supportWords: plan.supportWords,
    basicWords,
  })

  let { content, usage, finishReason } = await callModel({
    messages,
    targetWords: params.targetWords,
    signal,
  })
  let result = inspect(content, params)

  if (result.insufficient) {
    logger.warn(
      { ...describeContent(content), finishReason },
      'reading generate failed: model reported INSUFFICIENT_VOCABULARY',
    )
    throw insufficientVocabularyError()
  }

  // 第一轮：结构先过，再看用词。结构没过就没有稳定的正文可校验。
  let feedback = null
  if (!result.ok) {
    feedback = { reason: result.reason }
  } else {
    const vocabulary = inspectVocabulary(result.data, allowedWords)
    if (!vocabulary.valid) {
      feedback = { reason: vocabulary.reason, violations: vocabulary.violations }
    }
  }

  // 修正轮循环：P0 基线显示修 1 轮后 4/5 次只剩 1 个违规词，再给一轮的
  // 命中率远高于成本，因此 maxRepairRounds 默认 2（总调用 ≤ 3）。
  let repairRounds = 0
  while (feedback && repairRounds < config.maxRepairRounds) {
    repairRounds += 1
    logger.warn(
      {
        round: repairRounds,
        reason: feedback.reason,
        violations: feedback.violations,
        ...describeContent(content),
        finishReason,
      },
      'reading repair round',
    )

    // 结构合法时把它自己的输出放回上下文；结构不合法时不放，避免把半截 JSON
    // 当成"自己的话"喂回去，反而诱导模型照抄。
    const previous = result.ok ? content : ''

    const repaired = await callModel({
      messages: buildRepairMessages(messages, feedback, previous),
      targetWords: params.targetWords,
      signal,
    })

    content = repaired.content
    usage = repaired.usage ?? usage
    finishReason = repaired.finishReason ?? finishReason
    result = inspect(content, params)

    // 模型主动认输时再修也没用，跳出去交给下面的统一处理
    if (result.insufficient) break

    if (!result.ok) {
      feedback = { reason: result.reason }
      continue
    }

    const vocabulary = inspectVocabulary(result.data, allowedWords)
    feedback = vocabulary.valid
      ? null
      : { reason: vocabulary.reason, violations: vocabulary.violations }
  }

  if (result.insufficient) {
    logger.warn(
      { ...describeContent(content), finishReason, repairRounds },
      'reading generate failed: model reported INSUFFICIENT_VOCABULARY',
    )
    throw insufficientVocabularyError()
  }

  if (!result.ok) {
    logger.warn(
      { reason: result.reason, ...describeContent(content), finishReason, repairRounds },
      'reading generate failed: AI_INVALID_RESPONSE',
    )
    throw new ApiError(
      502,
      ERROR_CODES.AI_INVALID_RESPONSE,
      'AI 返回结构不合法，请稍后重试。',
    )
  }

  const data = result.data
  const actualWords = countWords(data.article)

  // 修正之后必须重新校验：结构合法不代表用词合法
  const vocabulary = validateArticle({
    article: data.article,
    allowedWords,
    names: data.names,
  })
  if (!vocabulary.valid) {
    logger.warn(
      {
        violations: vocabulary.violations.slice(0, 20),
        violationCount: vocabulary.unknownWords.length,
        actualWords,
        finishReason,
        repairRounds,
      },
      'reading generate failed: VOCABULARY_VALIDATION_FAILED',
    )
    throw new ApiError(
      422,
      ERROR_CODES.VOCABULARY_VALIDATION_FAILED,
      `文章使用了 ${vocabulary.unknownWords.length} 个不在词汇表内的单词：${vocabulary.unknownWords
        .slice(0, 5)
        .join('、')}`,
    )
  }

  const ratio = actualWords / params.targetWords
  if (ratio < WORD_COUNT_TOLERANCE.min || ratio > WORD_COUNT_TOLERANCE.max) {
    logger.warn(
      `article word count ${actualWords} deviates from target ${params.targetWords}`,
    )
  }

  logger.info(
    { actualWords, targetWords: params.targetWords, finishReason, repairRounds },
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
    targetPlan: {
      scope: selection.scope,
      poolSize: selection.poolSize,
      requiredWords: plan.requiredWords,
      focusWords: plan.focusWords,
    },
    names: data.names,
    status: 'generated',
    aiMeta: {
      model: config.deepseekModel,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      repairRounds,
      candidatePoolSize: selection.poolSize,
      requiredWords: plan.requiredWords,
    },
  })

  return toSafeDto(doc)
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
