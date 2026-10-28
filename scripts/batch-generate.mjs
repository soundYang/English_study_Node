#!/usr/bin/env node
/**
 * 固定测试集批量生成（方案 §3.4.3 / §3.4.4 / §12.2）
 *
 * 跑的是真实上游、真实数据库。一条用例 = 一次 HTTP 请求，脚本只负责
 * 「参数固化 + 结果落盘 + 判定是否符合预期」，不重试：失败本身就是数据。
 *
 * 前置：
 *   node scripts/seed-test-fixtures.mjs --fixture all
 *   DEFAULT_USER_ID=fixture-rich PORT=3100 node src/server.js
 *   DEFAULT_USER_ID=fixture-thin PORT=3101 node src/server.js
 *   DEFAULT_USER_ID=fixture-full PORT=3102 node src/server.js
 *
 * 采样时把限流关掉（`RATE_LIMIT_ENABLED=false`）：一次跑 20+ 个请求会撞上
 * 每分钟 20 次的配额，429 会混进成功率的分母。限流本身已有单测覆盖。
 *
 * 用法：
 *   node scripts/batch-generate.mjs --fixture rich --base http://127.0.0.1:3100
 *   node scripts/batch-generate.mjs --fixture full --base http://127.0.0.1:3102 --times 3
 *   node scripts/batch-generate.mjs --case 7 --base http://127.0.0.1:3100   # 只跑一条
 *   node scripts/batch-generate.mjs --fixture rich --dry-run               # 只看矩阵，不调模型
 *
 * 判定只认错误码；字数是否落在验收区间（±15%）单独用 `⚠️篇幅` 标出来，
 * 避免 50 词 / 730 词这种 201 被当成完全通过（md/21 W11）。
 *
 * ⚠️ 每条 201 都是一次真实付费调用。15 条用例里 thin 的 3 条走不到模型，
 * 实际付费是 12 条 × times；2026-10-28 实测全套 45 次共 ¥0.87。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import {
  FINAL_MODE_PERSONAL_WORDS,
  isFinalMode,
  maxTargetWordsFor,
  minKnownFor,
} from '../src/modules/readings/capacity-table.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { measureKnownVocabulary } from '../src/modules/readings/level-limits.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { VIOLATION_CATEGORIES } from '../src/modules/readings/vocabulary.service.js'
import { neededVocabulary, selectVocabularyPool } from '../src/modules/readings/vocabulary-pool.js'
import { Word } from '../src/modules/words/word.model.js'

const FIXTURE_USER = {
  rich: 'fixture-rich',
  thin: 'fixture-thin',
  full: 'fixture-full',
  // md/26 门槛采样
  'gate-easy': 'fixture-gate-easy',
  'gate-medium': 'fixture-gate-medium',
  'gate-hard': 'fixture-gate-hard',
  'rich-easy': 'fixture-rich-easy',
  'rich-hard': 'fixture-rich-hard',
  'form-easy': 'fixture-form-easy',
  'form-medium': 'fixture-form-medium',
  'form-hard': 'fixture-form-hard',
  // md/27：真人词库形态（从最高频开始取词），用来对照等距抽样的 fixture
  'real-hard': 'fixture-real-hard',
}

/**
 * 15 条用例（方案 §3.4.3，2026-10-28 按 md/21 W3 的门禁改写）。
 *
 * `expect` 不是「我们希望的」，而是**按当前公式算出来的必然结果**，
 * 所以它同时是门禁的回归断言。
 *
 * 与旧矩阵的两处差异（记进 md/21 §9）：
 *   1. 篇幅不能超过本档上限（easy 300 / medium 450 / hard 600），旧用例里
 *      easy 600、medium 600 会被 400 拦在调模型之前；
 *   2. hard 的 B 门要 3778 个已知词，`fixture-rich` 只有 720 个可用词，
 *      永远过不了门——hard 用例改用 `fixture-full`（1800 词全部已学）。
 *
 * thin 的三条是**闸门用例**：期望就是在调模型之前被 422 拦下，不产生费用。
 */
const CASES = [
  // rich：easy / medium 两档的常规篇幅
  { id: 1, fixture: 'rich', level: 'easy', targetWords: 100, vocabScope: ['all'], expect: 'ok' },
  { id: 2, fixture: 'rich', level: 'easy', targetWords: 200, vocabScope: ['all'], expect: 'ok' },
  { id: 3, fixture: 'rich', level: 'easy', targetWords: 300, vocabScope: ['all'], expect: 'ok' },
  { id: 4, fixture: 'rich', level: 'medium', targetWords: 200, vocabScope: ['all'], expect: 'ok' },
  { id: 5, fixture: 'rich', level: 'medium', targetWords: 400, vocabScope: ['all'], expect: 'ok' },
  { id: 6, fixture: 'rich', level: 'medium', targetWords: 450, vocabScope: ['all'], expect: 'ok' },
  {
    id: 7,
    fixture: 'rich',
    level: 'medium',
    targetWords: 400,
    vocabScope: ['today_new'],
    expect: 'ok',
  },
  {
    id: 8,
    fixture: 'rich',
    level: 'easy',
    targetWords: 200,
    vocabScope: ['today_reviewed'],
    expect: 'ok',
  },
  // full：hard 三档篇幅 + 复习词源
  { id: 9, fixture: 'full', level: 'hard', targetWords: 200, vocabScope: ['all'], expect: 'ok' },
  { id: 10, fixture: 'full', level: 'hard', targetWords: 400, vocabScope: ['all'], expect: 'ok' },
  { id: 11, fixture: 'full', level: 'hard', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
  {
    id: 12,
    fixture: 'full',
    level: 'hard',
    targetWords: 400,
    vocabScope: ['today_reviewed'],
    expect: 'ok',
  },
  // thin：三档都过不了 B 门，验证拦在调模型之前
  {
    id: 13,
    fixture: 'thin',
    level: 'easy',
    targetWords: 300,
    vocabScope: ['all'],
    expect: 'VOCABULARY_TOO_SMALL',
  },
  {
    id: 14,
    fixture: 'thin',
    level: 'medium',
    targetWords: 400,
    vocabScope: ['all'],
    expect: 'VOCABULARY_TOO_SMALL',
  },
  {
    id: 15,
    fixture: 'thin',
    level: 'hard',
    targetWords: 600,
    vocabScope: ['all'],
    expect: 'VOCABULARY_TOO_SMALL',
  },

  // ——— md/26：基础词量门槛采样（《设计方案》§3 的可达性验证） ———
  //
  // 三份基础词表不动，只调个人词库。level 按篇幅绑定。
  // gate-* = B 门刚好过 1 个词；form-* = 按《设计方案》§3 的门槛造的总量。
  //
  // 启动实例时必须带 `MAX_TARGET_WORDS=800`，否则 700/800 会被档位上限
  // 拦成 400，测到的是闸门而不是能力。
  { id: 16, group: 'gate', fixture: 'gate-easy', level: 'easy', targetWords: 100, vocabScope: ['all'], expect: 'ok' },
  { id: 17, group: 'gate', fixture: 'gate-easy', level: 'easy', targetWords: 200, vocabScope: ['all'], expect: 'ok' },
  { id: 18, group: 'gate', fixture: 'gate-easy', level: 'easy', targetWords: 300, vocabScope: ['all'], expect: 'ok' },
  { id: 19, group: 'gate', fixture: 'gate-medium', level: 'medium', targetWords: 400, vocabScope: ['all'], expect: 'ok' },
  { id: 20, group: 'gate', fixture: 'gate-medium', level: 'medium', targetWords: 450, vocabScope: ['all'], expect: 'ok' },
  { id: 21, group: 'gate', fixture: 'gate-medium', level: 'medium', targetWords: 500, vocabScope: ['all'], expect: 'ok' },
  { id: 22, group: 'gate', fixture: 'gate-hard', level: 'hard', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
  { id: 23, group: 'gate', fixture: 'gate-hard', level: 'hard', targetWords: 700, vocabScope: ['all'], expect: 'ok' },
  { id: 24, group: 'gate', fixture: 'gate-hard', level: 'hard', targetWords: 800, vocabScope: ['all'], expect: 'ok' },
  // 对照：B 门之上有余量
  { id: 25, group: 'gate', fixture: 'rich-easy', level: 'easy', targetWords: 300, vocabScope: ['all'], expect: 'ok' },
  { id: 26, group: 'gate', fixture: 'rich-hard', level: 'hard', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
  { id: 27, group: 'gate', fixture: 'rich-hard', level: 'hard', targetWords: 800, vocabScope: ['all'], expect: 'ok' },
  // 表单原值：总量按 §3 门槛造，预期全部被 B 门拦下（不调模型，不产生费用）
  { id: 28, group: 'gate', fixture: 'form-easy', level: 'easy', targetWords: 300, vocabScope: ['all'], expect: 'VOCABULARY_TOO_SMALL' },
  { id: 29, group: 'gate', fixture: 'form-medium', level: 'medium', targetWords: 500, vocabScope: ['all'], expect: 'VOCABULARY_TOO_SMALL' },
  { id: 30, group: 'gate', fixture: 'form-hard', level: 'hard', targetWords: 800, vocabScope: ['all'], expect: 'VOCABULARY_TOO_SMALL' },
  // md/27：同样 3160 个词，但取的是**最高频**的 3160 个（真人词库的形态）。
  // 与 #22 只差「词表怎么选」，用来证明 md/26 的失败是 fixture 造成的，不是生成器。
  { id: 31, group: 'gate', fixture: 'real-hard', level: 'hard', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
]

const QUESTION_COUNT = 3
const REQUEST_TIMEOUT_MS = 180_000

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

/** 轮次只留排障要用的字段：原句不进报告，但分类计数必须留（§3.4.4） */
function compactRounds(rounds = []) {
  return rounds.map((round) => ({
    kind: round.kind,
    repairFor: round.repairFor ?? null,
    feedbackType: round.feedbackType ?? null,
    actualWords: round.actualWords ?? null,
    unknownCount: (round.unknownWords ?? []).length,
    // null 表示这一轮没跑词汇校验（结构不合法 / 篇幅超长），不是「零违规」
    counts: round.counts
      ? Object.fromEntries(VIOLATION_CATEGORIES.map((key) => [key, round.counts[key] ?? 0]))
      : null,
    cacheHitTokens: round.cacheHitTokens ?? null,
    totalTokens: round.totalTokens ?? null,
    durationMs: round.durationMs ?? null,
    finishReason: round.finishReason ?? null,
  }))
}

const sum = (list, key) => list.reduce((acc, item) => acc + (item[key] ?? 0), 0)

async function fetchReading(doc) {
  return {
    readingId: String(doc._id),
    ok: true,
    status: 201,
    errorCode: null,
    actualWords: doc.actualWords ?? null,
    wordCountDeviation: doc.aiMeta?.wordCountDeviation ?? null,
    repairRounds: doc.aiMeta?.repairRounds ?? null,
    violationsCount: doc.aiMeta?.violationsCount ?? null,
    poolSize: doc.aiMeta?.candidatePoolSize ?? null,
    requiredWords: doc.aiMeta?.requiredWords ?? null,
    focusWords: doc.targetPlan?.focusWords?.length ?? null,
    totalTokens: doc.aiMeta?.totalTokens ?? null,
    promptTokens: doc.aiMeta?.promptTokens ?? null,
    completionTokens: doc.aiMeta?.completionTokens ?? null,
    model: doc.aiMeta?.model ?? null,
    basicWordsVersion: doc.aiMeta?.basicWordsVersion ?? null,
    codeVersion: doc.aiMeta?.codeVersion ?? null,
    rounds: compactRounds(doc.aiMeta?.rounds),
    article: doc.article,
  }
}

async function fetchFailure(userId, since) {
  const doc = await GenerationFailure.findOne({
    userId,
    createdAt: { $gte: new Date(since - 2_000) },
  })
    .sort({ createdAt: -1 })
    .lean()

  if (!doc) return null

  return {
    failureId: String(doc._id),
    ok: false,
    errorCode: doc.errorCode ?? null,
    actualWords: null,
    wordCountDeviation: null,
    repairRounds: doc.repairRounds ?? null,
    violationsCount: (doc.finalUnknownWords ?? []).length,
    poolSize: doc.poolSize ?? null,
    available: doc.available ?? null,
    requiredWords: doc.requiredWords ?? null,
    focusWords: null,
    totalTokens: doc.totalTokens ?? null,
    promptTokens: null,
    completionTokens: null,
    model: doc.model ?? null,
    basicWordsVersion: doc.basicWordsVersion ?? null,
    codeVersion: doc.codeVersion ?? null,
    rounds: compactRounds(doc.rounds),
    finalUnknownWords: doc.finalUnknownWords ?? [],
    finalViolations: (doc.finalViolations ?? []).map(({ normalized, category }) => ({
      normalized,
      category,
    })),
  }
}

function statusOf(record) {
  if (record.ok) return 'ok'
  return record.errorCode ?? 'UNKNOWN'
}

/** 期望与实际是否一致。判定标准是 §12.3 的前提：先确认门槛没漂 */
function judge(testCase, record) {
  const actual = statusOf(record)
  // 门槛公式与线上同源，不在这里重抄一遍
  const needed = neededVocabulary({ targetWords: testCase.targetWords, level: testCase.level })
  // gate_ok = 只要不是被闸门拦下就算通过；后续因词汇不足失败是预期内的
  const pass =
    testCase.expect === 'gate_ok' ? actual !== 'VOCABULARY_TOO_SMALL' : actual === testCase.expect

  return {
    expected: testCase.expect,
    actual,
    neededVocab: needed,
    pass,
    // 门槛用例必须顺带核对差额，否则「422 得对，但理由不对」会被漏掉
    detail:
      testCase.expect === 'VOCABULARY_TOO_SMALL' && record.available != null
        ? `available=${record.available} needed=${needed}`
        : null,
  }
}

async function runCase(testCase, { base, times, userId, withArticle }) {
  const rounds = []

  for (let run = 1; run <= times; run += 1) {
    const startedAt = Date.now()
    let record

    try {
      const response = await fetch(new URL('/api/readings/generate', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          level: testCase.level,
          targetWords: testCase.targetWords,
          vocabScope: testCase.vocabScope,
          questionCount: QUESTION_COUNT,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await response.json().catch(() => ({}))

      if (response.status === 201) {
        const doc = await Reading.findById(body.id).lean()
        if (!doc) throw new Error(`201 但库里查不到 Reading ${body.id}`)

        // 防串号：实例如果没带对 DEFAULT_USER_ID，会出现「拿 A 的池子跑 B 的用例」
        if (doc.userId !== userId) {
          throw new Error(
            `实例的用户是 ${doc.userId}，期望 ${userId}——检查启动命令里的 DEFAULT_USER_ID`,
          )
        }

        record = await fetchReading(doc)
      } else {
        record = await fetchFailure(userId, startedAt)
        if (!record) {
          // 没留痕的失败比失败本身更严重：这条必须显式标出来，不能当成普通失败
          record = {
            failureId: null,
            ok: false,
            errorCode: body?.error?.code ?? `HTTP_${response.status}`,
            rounds: [],
            failureMissing: true,
          }
        }
        record.status = response.status
      }
    } catch (error) {
      record = {
        failureId: null,
        ok: false,
        errorCode: 'REQUEST_FAILED',
        error: error.message,
        rounds: [],
      }
    }

    const durationMs = Date.now() - startedAt
    const judged = judge(testCase, record)

    // 判定只认错误码，字数是否落在验收区间（±15%）单独标记。
    // 不标的话，50 词 / 730 词的样本会跟着 201 一起打 ✓（md/21 W11）。
    const lengthOutside =
      record.ok &&
      Number.isFinite(record.wordCountDeviation) &&
      (record.wordCountDeviation < 0.85 || record.wordCountDeviation > 1.15)

    if (!withArticle && 'article' in record) delete record.article

    rounds.push({ run, durationMs, ...record, ...judged, lengthOutside })
    console.log(
      `  #${String(testCase.id).padStart(2)} run${run}  ${String(judged.actual).padEnd(22)}` +
        ` ${String(record.actualWords ?? '-').padStart(2)}词` +
        ` ${String(record.repairRounds ?? '-').padStart(2)}轮` +
        ` ${String(record.poolSize ?? '-').padStart(3)}池` +
        ` ${String(record.totalTokens ?? '-').padStart(5)}tok` +
        ` ${(durationMs / 1000).toFixed(1)}s  ${judged.pass ? '✓' : '✗'}` +
        `${lengthOutside ? ' ⚠️篇幅' : ''}`,
    )
  }

  return {
    caseId: testCase.id,
    ...testCase,
    fixtureUserId: userId,
    runs: rounds,
  }
}

function summarize(allCases, times) {
  const runs = allCases.flatMap((item) => item.runs)
  const byCase = allCases.map((item) => {
    const pools = new Set(item.runs.map((run) => run.poolSize).filter((size) => size != null))
    const failures = item.runs.filter((run) => !run.ok)

    return {
      caseId: item.caseId,
      level: item.level,
      targetWords: item.targetWords,
      vocabScope: item.vocabScope.join('+'),
      expected: item.expect,
      runs: item.runs.length,
      ok: item.runs.filter((run) => run.ok).length,
      failed: failures.length,
      errorCodes: [...new Set(failures.map((run) => run.errorCode))],
      // §3.4.5：同一用例多次跑，候选池必须完全一致
      poolConsistent: pools.size <= 1,
      poolSizes: [...pools],
      avgDurationMs: Math.round(sum(item.runs, 'durationMs') / item.runs.length),
      avgTotalTokens: Math.round(sum(item.runs, 'totalTokens') / item.runs.length),
      judgePassed: item.runs.every((run) => run.pass),
      lengthOutside: item.runs.filter((run) => run.lengthOutside).length,
    }
  })

  return {
    totalRuns: runs.length,
    expectedRuns: allCases.length * times,
    ok: runs.filter((run) => run.ok).length,
    failed: runs.filter((run) => !run.ok).length,
    judgeFailed: runs.filter((run) => !run.pass).length,
    lengthOutside: runs.filter((run) => run.lengthOutside).length,
    failureMissing: runs.filter((run) => run.failureMissing).length,
    poolInconsistent: byCase.filter((item) => !item.poolConsistent).map((item) => item.caseId),
    codes: Object.fromEntries(
      [...new Set(runs.map((run) => run.errorCode).filter(Boolean))].map((code) => [
        code,
        runs.filter((run) => run.errorCode === code).length,
      ]),
    ),
    byCase,
  }
}

/**
 * 按**线上同源**的函数判这条用例会走到哪一步（md/30 §7.3 的顺序）：
 * 解锁检查（400）→ 篇幅上限（400）→ 最低词量（422）→ A 门（池子够不够）。
 * 最终模式（hard + > 600 + 已解锁）跳过 A 门，只走前三道。
 */
function gateOf({ words, learnedWords, removedBasicWords, testCase }) {
  const { level, targetWords, vocabScope } = testCase
  const personalWords = learnedWords.length
  const finalMode = isFinalMode({ level, targetWords, personalWords })
  // 与服务器同源：实例带 MAX_TARGET_WORDS 时，dry-run 也必须按同一个上限判
  const maxTargetWords = config.maxTargetWordsOverride ?? maxTargetWordsFor(level, personalWords)

  if (targetWords > maxTargetWords) {
    return targetWords > 600 && level === 'hard' && !config.maxTargetWordsOverride
      ? {
          code: 'INVALID_REQUEST',
          note: `最终模式未解锁（个人词库 ${personalWords} < ${FINAL_MODE_PERSONAL_WORDS}）`,
        }
      : { code: 'INVALID_REQUEST', note: `档位上限 ${maxTargetWords} 词` }
  }

  const known = measureKnownVocabulary({ level, learnedWords, removedBasicWords })
  const minKnown = finalMode ? 0 : minKnownFor(targetWords, level)
  if (known.knownWords < minKnown) {
    return {
      code: 'VOCABULARY_TOO_SMALL',
      note: `已知词 ${known.knownWords} < minKnown ${minKnown}`,
    }
  }

  const selection = selectVocabularyPool({ words, level, scope: vocabScope, targetWords })
  if (!finalMode && !selection.sufficient) {
    return {
      code: 'VOCABULARY_TOO_SMALL',
      note: `A 门 available=${selection.available} needed=${selection.neededVocab}`,
    }
  }

  return {
    code: 'ok',
    note: `池子 ${selection.poolSize}，已知词 ${known.knownWords}${finalMode ? '，最终模式' : ''}`,
  }
}

async function dryRun(cases, times, base) {
  console.log(`\n[dry-run] base=${base}  times=${times}  用例 ${cases.length} 条\n`)

  for (const fixture of new Set(cases.map((item) => item.fixture))) {
    const userId = FIXTURE_USER[fixture]
    const words = await Word.find({ userId }).lean()
    const learnedWords = words
      .filter((item) => item.status === 'learning' || item.status === 'mastered')
      .map((item) => item.word)
    const removedBasicWords = words
      .filter((item) => item.status === 'new')
      .map((item) => item.word)

    console.log(
      `fixture ${fixture}（${userId}）：库里 ${words.length} 词，可入池 ${learnedWords.length} 个`,
    )

    if (words.length === 0) {
      console.log('  ⚠️ 该用户没有词，先跑 node scripts/seed-test-fixtures.mjs --fixture all')
    }

    for (const testCase of cases.filter((item) => item.fixture === fixture)) {
      const gate = gateOf({ words, learnedWords, removedBasicWords, testCase })

      console.log(
        `  #${String(testCase.id).padStart(2)} ${testCase.level.padEnd(6)} ` +
          `${String(testCase.targetWords).padStart(3)}词 ${testCase.vocabScope.join('+').padEnd(15)}` +
          ` → ${gate.code.padEnd(22)} ${gate.note}` +
          `  期望 ${testCase.expect}${gate.code === testCase.expect ? '' : '  ⚠️ 不符'}`,
      )
    }
    console.log('')
  }

  console.log('[dry-run] 未发起任何请求，未产生费用。')
}

async function main() {
  const base = argValue('base', 'http://127.0.0.1:3100')
  const times = Number(argValue('times', '3'))
  const fixtureArg = argValue('fixture')
  const groupArg = argValue('group')
  const caseArg = argValue('case')
  const withArticle = hasFlag('with-article')
  // 默认落在 samples/ 而不是 md/：这是跑出来的数据不是文档，md/ 下的文件按 NN_ 编号
  const suffix = caseArg ? `case${caseArg}` : (fixtureArg ?? 'all')
  const out = argValue('out', `samples/采样_${suffix}.json`)

  if (!Number.isInteger(times) || times < 1) throw new Error(`--times 必须是正整数`)

  let cases = CASES

  if (caseArg) {
    cases = cases.filter((item) => item.id === Number(caseArg))
    if (cases.length === 0) throw new Error(`没有编号为 ${caseArg} 的用例`)
  } else if (groupArg) {
    // md/26 的 gate 组：A/B/C 三组用例共用，按 fixture 分属不同实例
    cases = cases.filter((item) => item.group === groupArg)
    if (cases.length === 0) throw new Error(`没有 group 为 ${groupArg} 的用例`)
    if (fixtureArg) cases = cases.filter((item) => item.fixture === fixtureArg)
  } else if (fixtureArg) {
    cases = cases.filter((item) => item.fixture === fixtureArg)
    if (cases.length === 0) throw new Error(`fixture ${fixtureArg} 没有用例（可选 rich / thin）`)
  }

  await mongoose.connect(config.mongodbUri)

  try {
    if (hasFlag('dry-run')) {
      await dryRun(cases, times, base)
      return
    }

    const fixtures = [...new Set(cases.map((item) => item.fixture))]
    console.log(
      `\n[${new Date().toISOString()}] base=${base} 用例 ${cases.length} 条 × ${times} 次` +
        ` = ${cases.length * times} 次调用（真实付费）\n`,
    )

    const results = []

    for (const fixture of fixtures) {
      const userId = FIXTURE_USER[fixture]
      const count = await Word.countDocuments({ userId })
      console.log(`fixture ${fixture}（${userId}）：库里 ${count} 词`)

      const fixtureCases = cases.filter((item) => item.fixture === fixture)

      for (const testCase of fixtureCases) {
        results.push(await runCase(testCase, { base, times, userId, withArticle }))
      }
    }

    const summary = summarize(results, times)
    const payload = {
      startedAt: new Date().toISOString(),
      base,
      times,
      model: config.deepseekModel,
      codeVersion: results[0]?.runs[0]?.codeVersion ?? null,
      basicWordsVersion: results[0]?.runs[0]?.basicWordsVersion ?? null,
      summary,
      cases: results,
    }

    if (out) {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(payload, null, 2))
      console.log(`\n结果已写入 ${out}`)
    }

    console.log('\n汇总')
    console.log(
      `  共 ${summary.totalRuns} 次：成功 ${summary.ok}｜失败 ${summary.failed}｜` +
        `判定不符 ${summary.judgeFailed}｜篇幅越界 ${summary.lengthOutside}｜` +
        `失败未留痕 ${summary.failureMissing}`,
    )
    console.log(`  errorCode：${JSON.stringify(summary.codes)}`)
    console.log(
      `  候选池不一致的用例：${summary.poolInconsistent.length ? summary.poolInconsistent.join(', ') : '无'}`,
    )

    for (const item of summary.byCase) {
      console.log(
        `  #${String(item.caseId).padStart(2)} ${item.level.padEnd(6)} ${String(item.targetWords).padStart(3)}词` +
          ` ${item.vocabScope.padEnd(15)} 成功 ${item.ok}/${item.runs}` +
          ` 池 ${item.poolSizes.join('/') || '-'} ${item.judgePassed ? '✓' : '✗'}` +
          `${item.lengthOutside ? ` ⚠️篇幅 ${item.lengthOutside} 次` : ''}`,
      )
    }

    console.log(
      `  平均耗时 ${Math.round(sum(summary.byCase, 'avgDurationMs') / summary.byCase.length)}ms，` +
        `平均 ${Math.round(sum(summary.byCase, 'avgTotalTokens') / summary.byCase.length)} tokens/次`,
    )
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(async (error) => {
  console.error('[batch-generate] 失败：', error.message)
  process.exitCode = 1
  await mongoose.disconnect().catch(() => {})
})
