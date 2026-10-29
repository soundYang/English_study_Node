import { ApiError, ERROR_CODES, articleTooIncomplete } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { config } from '../../config/index.js'
import { freeAiKey } from '../ai-keys/ai-key.service.js'
import { parseAiContent } from './ai.schema.js'
import {
  buildFinishMessages,
  buildSegmentMessages,
  buildSegmentRepairMessages,
  buildSegmentSimplifyMessages,
} from './ai.prompt.js'
import { callModel } from './model-call.js'
import { collectWordForms, validateArticle } from './vocabulary.service.js'
import {
  countWords,
  planSegmentCeilings,
  segmentWordCeiling,
} from './word-count.js'

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

/**
 * 段级容错可以吞掉的错误（md/55 §4.6）。
 *
 * 这些都是「上游这一次没成功」，换一段/下一轮还有机会；吞掉后该段记 dropped，
 * 整篇是否还能交付仍由 MIN_SEGMENT_ACCEPTANCE 决定。
 */
const DROPPABLE_SEGMENT_CODES = new Set([
  ERROR_CODES.AI_PROVIDER_ERROR,
  ERROR_CODES.AI_PROVIDER_BUSY,
  ERROR_CODES.AI_INVALID_RESPONSE,
])

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
 *
 * 篇幅与词表一样是硬条件：段的 `limitWords` 是整篇预算分下来的份额（W11 缺口 2），
 * 收下一段超长的就等于把整篇推过验收上界，所以压不下来时丢段而不是标记放行。
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
  // 段内每次调用都要记到这个人 / 这个任务头上（md/37 §8 S2）；
  // 不往这里传的话，分段路径的流水会落到空用户上，后台少掉一半费用
  userId = '',
  taskId = null,
  // md/43：本次生成用哪把 Key。由入口解析一次后一路传下来，段内不查库
  aiKey = freeAiKey(),
  // 补段模式：这次已经是同一个空槽的第二次机会，只给一轮，失败就认输——
  // 它刚走完一整条重写链，再走一遍是重复烧钱。
  singleAttempt = false,
  // md/41：本段最多允许收下几个「真正越界」的生词。默认 0（原有零容忍）。
  // 额度按段号静态分配，见 generateSegmented 里的说明。
  unknownAllowance = 0,
}) {
  // 段级篇幅硬上限：调用方按整篇预算分配好（W11 缺口 2）；
  // 单独调用本函数时退回「本段目标 × 1.15」的老口径。
  const limitWords = Number.isFinite(segment.limitWords)
    ? segment.limitWords
    : segmentWordCeiling(segment.maxWords)

  const stats = {
    id: segment.id,
    goal: segment.goal,
    maxWords: segment.maxWords,
    limitWords,
    attempts: 0,
    actualWords: 0,
    overLength: false,
    accepted: false,
    unknownWords: [],
    // 0 = 零容忍（默认）。>0 只可能出现在用户打开 allowNewWords 的请求里
    unknownAllowance,
  }

  let text = ''
  let violations = []
  let lengthOk = true

  const attempt = async ({ messages, kind, repairFor }) => {
    stats.attempts += 1

    const response = await callModel({
      kind,
      repairFor,
      messages,
      signal,
      rounds,
      temperature: config.segmentTemperature,
      userId,
      taskId,
      aiKey,
    })

    text = parseSegmentText(response.content)
    const vocabulary = text
      ? validateArticle({ article: text, allowedWords, names: [...names] })
      : null

    // 人名从任意一次尝试里认出来都收下：后面的段可能也会用到
    for (const name of vocabulary?.detectedNames ?? []) names.add(name)

    // 额度内的「真生词」照收：unknownAllowance 默认 0，行为与原来完全一致。
    // violations 已按词去重，这里数的是不同的越界词，不是出现次数。
    const vocabularyOk =
      Boolean(vocabulary) && blockingOnly(vocabulary.violations).length <= unknownAllowance
    lengthOk = countWords(text) <= limitWords
    violations = vocabulary?.violations ?? []

    const accepted = vocabularyOk && lengthOk
    annotateRound(rounds, { text, vocabulary, accepted })

    return { accepted, vocabulary, vocabularyOk }
  }

  /** 片段超长时给重写提示词用的说明；没超长返回 null */
  const overWords = () =>
    lengthOk ? null : { actual: countWords(text), limit: limitWords }

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

  if (!lengthOk) {
    logger.warn(
      { segment: segment.id, actualWords: countWords(text), limitWords },
      'segment over length limit',
    )
  }

  // 补段只给这一轮：失败就交回调用方，由整篇接收率决定要不要判失败。
  // 超长同样不能收：这段的 `limitWords` 是整篇预算的一部分，
  // 收下它就等于让整篇越过验收上界（W11 缺口 2）。
  if (singleAttempt) {
    stats.actualWords = countWords(text)
    stats.unknownWords = first.vocabulary?.unknownWords ?? []
    stats.overLength = !lengthOk

    if (first.vocabularyOk && lengthOk) {
      stats.accepted = true
      return { accepted: true, text, stats }
    }

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
        overWords: overWords(),
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

  // ③ 降级：去掉这段没成功用上的目标词，用最简单的说法再写一次。
  // 若这时的超长还没解决，一并把压缩要求写进提示词——最后一次机会，
  // 不能只让它「换简单说法」却不知道还得更短。
  const forms = new Set(collectWordForms(text))
  const simplified = {
    ...segment,
    mustUse: segment.mustUse.filter((word) => !forms.has(word)),
  }
  const last = await attempt({
    kind: 'repair',
    repairFor: 'vocabulary',
    messages: buildSegmentSimplifyMessages(systemPrompt, {
      segment: simplified,
      index,
      overWords: overWords(),
    }),
  })

  stats.actualWords = countWords(text)
  stats.unknownWords = last.vocabulary?.unknownWords ?? []
  stats.overLength = !lengthOk

  // 词表和篇幅都干净才收（理由见文件顶部：收下超长段会推高整篇）
  if (last.vocabularyOk && lengthOk) {
    stats.accepted = true
    return { accepted: true, text, stats }
  }

  if (last.vocabularyOk) {
    logger.warn(
      { segment: segment.id, actualWords: stats.actualWords, limitWords },
      'segment over length after retries: dropped',
    )
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
  // token 流水归属（md/37）：整篇与分段两个策略必须同口径，
  // 否则后台看到的费用会少掉分段那一半
  userId = '',
  taskId = null,
  // md/43：本次生成用哪把 Key（'free' 全站池 / 'user' 自备）
  aiKey = freeAiKey(),
  questionCount,
  range,
  level,
  acceptedMax,
  // md/41：全篇允许收下的不同生词数。0 = 原有零容忍；>0 时按段号静态分配，
  // 见下面 unknownAllowances 的说明。
  unknownBudget = 0,
  // 段级进度回调（md/31 §6）：每批跑完、每轮补段后各调一次，
  // 参数是单段状态 { index, status, words, text }。不传则整条链路行为不变。
  onSegment = null,
  // 续跑（md/31 §11）：{ [1 起的段号]: 已收下的正文 }。
  // 传了的段不再调模型，直接进正文——这正是「失败只补失败段」省下来的钱。
  prewritten = null,
  // 计划定型回调：把带 limitWords 的最终计划交出去（任务表靠它续跑）。
  // 段级上限在下面才算出来，所以不能由调用方自己算一遍再传进来。
  onPlan = null,
}) {
  const emitSegment = async (index, stats, text) => {
    if (typeof onSegment !== 'function') return

    await onSegment({
      index: index + 1, // 对外 1 起，与提示词里的段号一致
      status: stats.accepted ? 'accepted' : 'dropped',
      words: stats.actualWords ?? 0,
      attempts: stats.attempts ?? 0,
      // 正文一起出去：任务表靠它做断点续跑，丢了就只能整篇重来
      text: stats.accepted ? String(text ?? '') : '',
      // 已认出的专有名词：续跑时下一段还要靠它们通过词表校验
      names: [...names],
    })
  }

  // 每段都带上完整计划：并发生成拿不到「上一段的最后一句」，
  // 但至少要知道全文走向，否则四段各写各的（md/20 §5.3，见 md/21 §9 偏离）
  //
  // 段级上限来自整篇预算（W11 缺口 2）：Σ 上限 = acceptedMax，
  // 于是「每段都合格」就等价于「整篇不超长」。不传时退回老的各自 1.15 倍口径，
  // 只为兼容离线脚本，生产调用方必须传。
  //
  // 续跑时段的 `limitWords` 已经在第一次跑的时候就分好并落库了：
  // 重算一遍会因为「已有段」的 maxWords 相同而得到同一个结果，
  // 但依赖「用户词库此刻的状态」去重算没有意义，直接用存下来的那份。
  const reusePlan = segments.every((segment) => Number.isFinite(segment.limitWords))
  const ceilings = reusePlan
    ? segments.map((segment) => segment.limitWords)
    : planSegmentCeilings(
        segments,
        Number.isFinite(acceptedMax)
          ? acceptedMax
          : segments.reduce((sum, segment) => sum + segmentWordCeiling(segment.maxWords), 0),
      )
  const plan = reusePlan
    ? segments
    : segments.map((segment, index) => ({ ...segment, limitWords: ceilings[index] }))
  const outline = plan.map(({ id, goal }) => `${id}. ${goal}`).join('\n')

  // 生词额度按段号静态分配（md/41）：前 `unknownBudget` 段各 1 个，其余 0。
  // 段是并发生成的，没法共享「已用额度」计数器；静态分配是唯一能保证
  // 「全篇收下的不同生词 ≤ 预算」的做法。补段沿用同一段号的额度，
  // 续跑段本来就是上一轮按自己的额度通过的，不重新分配。
  const unknownAllowances = plan.map((_, index) => (index < unknownBudget ? 1 : 0))

  if (typeof onPlan === 'function') await onPlan(plan)

  /** 写第 index 段。refill 时清空 mustUse：补段先保住正文，不再强求覆盖目标词。 */
  const writeSegment = (index, refill) =>
    generateOneSegment({
      segment: refill ? { ...plan[index], mustUse: [] } : plan[index],
      index: index + 1,
      total: plan.length,
      outline,
      previousGoal: plan[index - 1]?.goal ?? '',
      nextGoal: plan[index + 1]?.goal ?? '',
      systemPrompt,
      allowedWords,
      names,
      signal,
      rounds,
      userId,
      taskId,
      aiKey,
      singleAttempt: refill,
      unknownAllowance: unknownAllowances[index] ?? 0,
    })

  /**
   * 单段失败只丢这一段（md/55 §4.6）。
   *
   * 反过来，鉴权错误、参数错误、取消 / deadline 以及真正的未知异常必须继续
   * 向上抛：把它们也吞成 dropped，用户会拿到一篇「少了几段」的文章，
   * 而不是一个能据以重试的错误。
   */
  const isFatalSegmentError = (error) => {
    if (signal?.aborted) return true
    if (error?.name === 'AbortError') return true

    return !DROPPABLE_SEGMENT_CODES.has(error?.code)
  }

  const safeWriteSegment = async (index, refill) => {
    try {
      return await writeSegment(index, refill)
    } catch (error) {
      if (isFatalSegmentError(error)) throw error

      logger.warn(
        { segment: plan[index].id, code: error?.code, err: error },
        'segment failed, dropped',
      )

      return {
        accepted: false,
        text: '',
        stats: {
          id: plan[index].id,
          goal: plan[index].goal,
          maxWords: plan[index].maxWords,
          limitWords: plan[index].limitWords,
          attempts: 0,
          actualWords: 0,
          overLength: false,
          accepted: false,
          unknownWords: [],
          unknownAllowance: unknownAllowances[index] ?? 0,
          errorCode: error?.code ?? ERROR_CODES.AI_PROVIDER_ERROR,
        },
      }
    }
  }

  const indexes = segments.map((_, index) => index)
  const results = new Array(indexes.length)
  const pendingIndexes = []

  // 续跑：已收下的段直接放进结果，先报一次进度，让前端一开跑就看到 done 不为 0
  const stored = prewritten && typeof prewritten === 'object' ? prewritten : {}
  for (const index of indexes) {
    const text = stored[index + 1]

    if (typeof text === 'string' && text.trim()) {
      const stats = {
        id: plan[index].id,
        goal: plan[index].goal,
        maxWords: plan[index].maxWords,
        limitWords: plan[index].limitWords,
        // 计 1 次：它当初确实调过一次模型，repairCount 按 attempts-1 汇总
        attempts: 1,
        actualWords: countWords(text),
        overLength: false,
        accepted: true,
        unknownWords: [],
        resumed: true,
      }

      results[index] = { accepted: true, text, stats }
      await emitSegment(index, stats, text)
    } else {
      pendingIndexes.push(index)
    }
  }

  const fresh = await mapWithConcurrency(pendingIndexes, config.segmentConcurrency, (index) =>
    safeWriteSegment(index, false),
  )
  for (const [position, index] of pendingIndexes.entries()) {
    results[index] = fresh[position]
  }

  // 首轮跑完就把每段的真实结果推出去：被丢弃的段也要报「dropped」，
  // 否则进度条会永远差最后几格，用户以为卡死了
  for (const index of pendingIndexes) {
    await emitSegment(index, results[index].stats, results[index].text)
  }

  // 补段（md/27 §3.2 M1）：丢一段不是「这段不重要」，而是整篇少 60 个词。
  // 用空 mustUse 再写一次，成功就补回原位。只补 config.segmentRefillRounds 轮，
  // 每段只给一次调用——它刚走完一整条重写链，再走一遍是重复烧钱。
  let refillAccepted = 0
  for (let round = 0; round < config.segmentRefillRounds; round += 1) {
    // 只补这一轮真的写过的段：续跑带进来的段本来就是收下的状态
    const missing = pendingIndexes.filter((index) => !results[index].accepted)
    if (missing.length === 0) break

    const retries = await mapWithConcurrency(missing, config.segmentConcurrency, (index) =>
      safeWriteSegment(index, true),
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

    // 补段改变了这几段的最终状态，重新推一次（同一格以最后一次为准）
    for (const index of missing) {
      await emitSegment(index, results[index].stats, results[index].text)
    }
  }

  const stats = results.map((item) => item.stats)
  const accepted = results.filter((item) => item.accepted)
  const article = accepted.map((item) => item.text).join('\n\n')
  const acceptance = segments.length > 0 ? accepted.length / segments.length : 0
  const articleWords = countWords(article)

  // 按构造不可能超：每段 ≤ 自己的份额，份额之和 = acceptedMax。
  // 真超了说明有段绕过了长度校验——留痕，而不是静默返回一篇超长正文。
  if (Number.isFinite(acceptedMax) && articleWords > acceptedMax) {
    logger.warn(
      { actualWords: articleWords, acceptedMax, limits: ceilings },
      'segmented article over global length budget',
    )
  }

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
    userId,
    taskId,
    aiKey,
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
      actualWords: articleWords,
      acceptedMax: Number.isFinite(acceptedMax) ? acceptedMax : null,
      limits: ceilings,
      targetRange: range.label,
      // md/41：预算与「实际收下的不同生词」。开着开关但模型没用生词时这里是 0
      unknownBudget,
      acceptedUnknownWords: [
        ...new Set(stats.filter((item) => item.accepted).flatMap((item) => item.unknownWords)),
      ].length,
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
