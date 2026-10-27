import { config } from '../../config/index.js'
import { ApiError, ERROR_CODES } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { wordRepository } from '../words/word.repository.js'
import { chatJson } from './ai.client.js'
import { buildMessages, buildRepairMessages } from './ai.prompt.js'
import { parseAiContent, validateAiReading } from './ai.schema.js'
import { basicWords } from './basic-words.js'
import { toSafeDto } from './reading.dto.js'
import { readingRepository as repo } from './reading.repository.js'
import { generateReadingSchema } from './reading.schema.js'
import { validateArticle } from './vocabulary.service.js'

/** vocabularySnapshot 的上限，与 Schema 注释一致 */
const VOCABULARY_SNAPSHOT_LIMIT = 200
const MAX_TOKENS_CAP = 2600
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
  const { content, usage } = await chatJson({
    messages,
    signal,
    maxTokens: estimateMaxTokens(targetWords),
  })

  return { content, usage }
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
 * 流程：参数校验 → 词汇量检查 → 组装允许词汇 → 调模型
 *       → 结构校验 → 词汇校验 →（最多 1 轮修正，结构与词汇共用这一轮）
 *       → 落库 → 返回安全 DTO。
 *
 * 结构与词汇共用同一轮修正：上游调用总数硬上限是 2 次（MAX_REPAIR_ROUNDS=1），
 * 不设"再试一次就好"的循环，否则一次生成就能把预算烧光。
 */
export async function generateReading({ userId, body, signal }) {
  const params = parseOrThrow(generateReadingSchema, body)

  // 只有 learning / mastered 算可用词汇，new 不算
  const available = await wordRepository.countVocabulary(userId)
  if (available < config.vocabularyThreshold) {
    throw new ApiError(
      422,
      ERROR_CODES.INSUFFICIENT_VOCABULARY,
      `当前已有 ${available} 个单词，至少需要 ${config.vocabularyThreshold} 个才能生成`,
    )
  }

  const words = await wordRepository.findVocabulary(
    userId,
    VOCABULARY_SNAPSHOT_LIMIT,
  )
  const vocabularySnapshot = words.map((item) => item.word)
  const allowedWords = new Set([...vocabularySnapshot, ...basicWords])

  const messages = buildMessages({
    level: params.level,
    targetWords: params.targetWords,
    questionCount: params.questionCount,
    allowedWords,
  })

  let { content, usage } = await callModel({
    messages,
    targetWords: params.targetWords,
    signal,
  })
  let result = inspect(content, params)

  if (result.insufficient) throw insufficientVocabularyError()

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

  let repairRounds = 0
  if (feedback && config.maxRepairRounds > 0) {
    repairRounds = 1
    logger.warn(`reading repair round: ${feedback.reason}`)

    const repaired = await callModel({
      messages: buildRepairMessages(messages, feedback),
      targetWords: params.targetWords,
      signal,
    })

    content = repaired.content
    usage = repaired.usage ?? usage
    result = inspect(content, params)
  }

  if (result.insufficient) throw insufficientVocabularyError()

  if (!result.ok) {
    throw new ApiError(
      502,
      ERROR_CODES.AI_INVALID_RESPONSE,
      'AI 返回结构不合法，请稍后重试。',
    )
  }

  const data = result.data

  // 修正之后必须重新校验：结构合法不代表用词合法
  const vocabulary = validateArticle({
    article: data.article,
    allowedWords,
    names: data.names,
  })
  if (!vocabulary.valid) {
    throw new ApiError(
      422,
      ERROR_CODES.VOCABULARY_VALIDATION_FAILED,
      `文章使用了 ${vocabulary.unknownWords.length} 个不在词汇表内的单词：${vocabulary.unknownWords
        .slice(0, 5)
        .join('、')}`,
    )
  }

  const actualWords = countWords(data.article)
  const ratio = actualWords / params.targetWords
  if (ratio < WORD_COUNT_TOLERANCE.min || ratio > WORD_COUNT_TOLERANCE.max) {
    logger.warn(
      `article word count ${actualWords} deviates from target ${params.targetWords}`,
    )
  }

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
    names: data.names,
    status: 'generated',
    aiMeta: {
      model: config.deepseekModel,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      repairRounds,
    },
  })

  return toSafeDto(doc)
}
