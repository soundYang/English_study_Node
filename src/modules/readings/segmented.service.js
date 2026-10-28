import { ApiError, ERROR_CODES, articleTooIncomplete } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { config } from '../../config/index.js'
import { parseAiContent } from './ai.schema.js'
import {
  buildFinishMessages,
  buildSegmentMessages,
  buildSegmentRepairMessages,
  buildSegmentSimplifyMessages,
} from './ai.prompt.js'
import { callModel } from './model-call.js'
import { collectWordForms, validateArticle } from './vocabulary.service.js'
import { countWords } from './word-count.js'

/**
 * 句级闭环生成（md/20 §5 / md/21 W4）。
 *
 * 与整篇路径的根本区别：**每一段在进入正文之前就已经通过校验**。
 * 通不过只重写这一段，最多 2 次；再不行就降级（去掉没用的目标词 + 更简单的说法），
 * 仍不行则丢弃该段。整条链路不会因为「某一段写不好」而 422。
 */

/**
 * 段级校验里可以「收下」的违规类别。
 *
 *   proper_noun  —— 人名，加进 names 即可放行；
 *   wordform     —— W1 之后不应出现，出现说明校验器有缺口，记 warn 不卡生成；
 *   abbreviation —— 同上。
 *
 * 其余三类（missing_common / rare / unknown_token）才是模型真的越界，必须重写。
 */
const ACCEPTED_CATEGORIES = new Set(['proper_noun', 'wordform', 'abbreviation'])

/** 只留下真正需要重写的违规；人名/词形/缩写不卡生成 */
function blockingOnly(violations) {
  return violations.filter(({ category }) => !ACCEPTED_CATEGORIES.has(category))
}

/** 模型偶尔会把 text 写成 article；两种都认，实在没有就当作一次失败 */
function parseSegmentText(content) {
  const parsed = parseAiContent(content)
  if (!parsed || typeof parsed !== 'object') return ''

  const text = parsed.text ?? parsed.article ?? ''
  return typeof text === 'string' ? text.trim() : ''
}

/** 并发跑一组任务，结果按输入顺序返回 */
async function mapWithConcurrency(items, limit, run) {
  const results = new Array(items.length)
  let next = 0

  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return

      results[index] = await run(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

/**
 * 给调用方的这一轮补上判定结果，口径与整篇路径的 recordRound 一致：
 * rounds 是给人看的明细，没有 unknownWords / counts 的轮次会被误读成「查了，没问题」。
 */
function annotateRound(rounds, { text, vocabulary, accepted }) {
  const last = rounds.at(-1)
  if (!last) return

  last.actualWords = countWords(text)
  last.unknownWords = vocabulary?.unknownWords ?? []
  if (vocabulary) last.counts = vocabulary.counts
  last.feedbackType = accepted ? null : 'vocabulary'
}

/**
 * 写一段并闭环校验。返回值里的 accepted 决定这一段是否进入正文。
 *
 * 尝试顺序（每次都是一次独立的模型调用）：
 *   1. 首轮生成
 *   2..1+maxAttempts. 带违规原句的段内重写（允许删掉这个意思）
 *   最后一次. 去掉没成功用上的目标词，用最简单的说法再写一次
 * 仍不通过 → 丢弃该段（由调用方把篇幅缺口记进日志，不重试）。
 */
async function generateOneSegment({
  segment,
  index,
  total,
  outline,
  previousGoal,
  nextGoal,
  systemPrompt,
  allowedWords,
  names,
  signal,
  rounds,
  // 补段模式：这次已经是同一个空槽的第二次机会，只给一轮，失败就认输——
  // 它刚走完一整条重写链，再走一遍是重复烧钱。
  singleAttempt = false,
}) {
  const stats = {
    id: segment.id,
    goal: segment.goal,
    maxWords: segment.maxWords,
    attempts: 0,
    actualWords: 0,
    accepted: false,
    unknownWords: [],
  }

  let text = ''
  let violations = []

  const attempt = async ({ messages, kind, repairFor }) => {
    stats.attempts += 1

    const response = await callModel({
      kind,
      repairFor,
      messages,
      signal,
      rounds,
      temperature: config.segmentTemperature,
    })

    text = parseSegmentText(response.content)
    const vocabulary = text
      ? validateArticle({ article: text, allowedWords, names: [...names] })
      : null

    // 人名从任意一次尝试里认出来都收下：后面的段可能也会用到
    for (const name of vocabulary?.detectedNames ?? []) names.add(name)

    const accepted = Boolean(vocabulary) && blockingOnly(vocabulary.violations).length === 0
    violations = vocabulary?.violations ?? []

    annotateRound(rounds, { text, vocabulary, accepted })

    return { accepted, vocabulary }
  }

  // ① 首轮
  const first = await attempt({
    kind: 'segment',
    repairFor: null,
    messages: buildSegmentMessages(systemPrompt, {
      segment,
      index,
      total,
      outline,
      previousGoal,
      nextGoal,
    }),
  })
  if (first.accepted) {
    Object.assign(stats, {
      accepted: true,
      actualWords: countWords(text),
      unknownWords: first.vocabulary.unknownWords,
    })
    return { accepted: true, text, stats }
  }

  // 补段只给这一轮：失败就交回调用方，由整篇接收率决定要不要判失败
  if (singleAttempt) {
    stats.actualWords = countWords(text)
    stats.unknownWords = first.vocabulary?.unknownWords ?? []
    logger.warn(
      { segment: segment.id, actualWords: stats.actualWords },
      'segment refill attempt rejected',
    )

    return { accepted: false, text: '', stats }
  }

  // ② 段内重写：只重写这一段，且允许删掉意思
  for (let round = 0; round < config.segmentMaxAttempts; round += 1) {
    const result = await attempt({
      kind: 'repair',
      repairFor: 'vocabulary',
      messages: buildSegmentRepairMessages(systemPrompt, {
        segment,
        index,
        text,
        violations: blockingOnly(violations),
      }),
    })

    if (result.accepted) {
      Object.assign(stats, {
        accepted: true,
        actualWords: countWords(text),
        unknownWords: result.vocabulary.unknownWords,
      })
      return { accepted: true, text, stats }
    }
  }

  // ③ 降级：去掉这段没成功用上的目标词，用最简单的说法再写一次
  const forms = new Set(collectWordForms(text))
  const simplified = {
    ...segment,
    mustUse: segment.mustUse.filter((word) => !forms.has(word)),
  }
  const last = await attempt({
    kind: 'repair',
    repairFor: 'vocabulary',
    messages: buildSegmentSimplifyMessages(systemPrompt, { segment: simplified, index }),
  })

  stats.actualWords = countWords(text)
  stats.unknownWords = last.vocabulary?.unknownWords ?? []

  if (last.accepted) {
    stats.accepted = true
    return { accepted: true, text, stats }
  }

  logger.warn(
    { segment: segment.id, attempts: stats.attempts, violations: stats.unknownWords },
    'segment dropped after retries',
  )

  return { accepted: false, text: '', stats }
}

function parseFinish(content) {
  const parsed = parseAiContent(content)
  return parsed && typeof parsed === 'object' ? parsed : null
}

/**
 * 跑完整条分段链路：并发写段 → 拼装 → 收尾。
 *
 * @returns {Promise<{
 *   data: { title: string, article: string, translation: string, names: string[], questions: Array },
 *   stats: Array,
 *   repairCount: number,
 *   finishReason: string|null,
 *   detectedNames: string[],
 * }>}
 */
export async function generateSegmented({
  segments,
  systemPrompt,
  allowedWords,
  names,
  signal,
  rounds,
  questionCount,
  range,
  level,
}) {
  // 每段都带上完整计划：并发生成拿不到「上一段的最后一句」，
  // 但至少要知道全文走向，否则四段各写各的（md/20 §5.3，见 md/21 §9 偏离）
  const outline = segments.map(({ id, goal }) => `${id}. ${goal}`).join('\n')

  /** 写第 index 段。refill 时清空 mustUse：补段先保住正文，不再强求覆盖目标词。 */
  const writeSegment = (index, refill) =>
    generateOneSegment({
      segment: refill ? { ...segments[index], mustUse: [] } : segments[index],
      index: index + 1,
      total: segments.length,
      outline,
      previousGoal: segments[index - 1]?.goal ?? '',
      nextGoal: segments[index + 1]?.goal ?? '',
      systemPrompt,
      allowedWords,
      names,
      signal,
      rounds,
      singleAttempt: refill,
    })

  const indexes = segments.map((_, index) => index)
  const results = await mapWithConcurrency(indexes, config.segmentConcurrency, (index) =>
    writeSegment(index, false),
  )

  // 补段（md/27 §3.2 M1）：丢一段不是「这段不重要」，而是整篇少 60 个词。
  // 用空 mustUse 再写一次，成功就补回原位。只补 config.segmentRefillRounds 轮，
  // 每段只给一次调用——它刚走完一整条重写链，再走一遍是重复烧钱。
  let refillAccepted = 0
  for (let round = 0; round < config.segmentRefillRounds; round += 1) {
    const missing = indexes.filter((index) => !results[index].accepted)
    if (missing.length === 0) break

    const retries = await mapWithConcurrency(missing, config.segmentConcurrency, (index) =>
      writeSegment(index, true),
    )

    for (const [position, index] of missing.entries()) {
      const retry = retries[position]

      if (retry.accepted) refillAccepted += 1
      results[index] = {
        accepted: retry.accepted,
        text: retry.text,
        stats: {
          ...retry.stats,
          // 尝试次数要累加：repairRounds 按 attempts-1 汇总，
          // 只留补段那一轮会把首轮的 4 次尝试从统计里抹掉
          attempts: results[index].stats.attempts + retry.stats.attempts,
          refilled: true,
        },
      }
    }
  }

  const stats = results.map((item) => item.stats)
  const accepted = results.filter((item) => item.accepted)
  const article = accepted.map((item) => item.text).join('\n\n')
  const acceptance = segments.length > 0 ? accepted.length / segments.length : 0

  if (!accepted.length) {
    throw new ApiError(
      502,
      ERROR_CODES.AI_INVALID_RESPONSE,
      'AI 返回结构不合法，请稍后重试。',
    )
  }

  // 接收率下限（md/23 D2）：残篇不再当成功返回。
  // 放在收尾之前——判断只用到正文词数，没必要为一个注定失败的请求再调一次模型。
  if (acceptance < config.minSegmentAcceptance) {
    logger.warn(
      {
        total: segments.length,
        accepted: accepted.length,
        minAcceptance: config.minSegmentAcceptance,
      },
      'segmented generation rejected: too many segments dropped',
    )
    throw articleTooIncomplete({
      accepted: accepted.length,
      total: segments.length,
      actualWords: countWords(article),
      minAcceptance: config.minSegmentAcceptance,
    })
  }

  const detectedNames = [...names]
  const finish = await callModel({
    kind: 'finish',
    messages: buildFinishMessages(systemPrompt, {
      article,
      questionCount,
      paragraphCount: accepted.length,
      // 题型配额的提示词口径跟难度走（W7）
      level,
    }),
    signal,
    rounds,
    temperature: config.segmentTemperature,
  })

  const parsed = parseFinish(finish.content)

  if (!parsed) {
    throw new ApiError(
      502,
      ERROR_CODES.AI_INVALID_RESPONSE,
      'AI 返回结构不合法，请稍后重试。',
    )
  }

  const declaredNames = Array.isArray(parsed.names)
    ? parsed.names.filter((name) => typeof name === 'string' && name.trim())
    : []
  // names 去重后最多 3 个：规则里就这么写的，超出部分不写进文档
  const mergedNames = [...new Set([...declaredNames, ...detectedNames].map((name) => name.trim()))]
    .slice(0, 3)

  logger.info(
    {
      segments: segments.length,
      accepted: accepted.length,
      dropped: segments.length - accepted.length,
      refilled: refillAccepted,
      actualWords: countWords(article),
      targetRange: range.label,
      attempts: stats.map(({ id, attempts }) => ({ id, attempts })),
    },
    'segmented generation assembled',
  )

  return {
    data: {
      title: parsed.title,
      article,
      translation: parsed.translation,
      names: mergedNames,
      questions: parsed.questions,
    },
    stats,
    // 除首轮外的所有调用都算「修正」，与整篇路径的 repairRounds 口径一致
    repairCount: stats.reduce((sum, item) => sum + Math.max(0, item.attempts - 1), 0),
    finishReason: finish.finishReason ?? null,
    detectedNames: detectedNames.filter((name) => !mergedNames.includes(name)),
  }
}
