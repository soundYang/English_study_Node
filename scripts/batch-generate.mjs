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
 *
 * 用法：
 *   node scripts/batch-generate.mjs --fixture rich --base http://127.0.0.1:3100
 *   node scripts/batch-generate.mjs --fixture thin --base http://127.0.0.1:3101 --times 3
 *   node scripts/batch-generate.mjs --case 7 --base http://127.0.0.1:3100   # 只跑一条
 *   node scripts/batch-generate.mjs --fixture rich --dry-run               # 只看矩阵，不调模型
 *
 * ⚠️ 每条 201 都是一次真实付费调用。600 词档单次约 ¥0.06，全套 45 次约 ¥2–3。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { VIOLATION_CATEGORIES } from '../src/modules/readings/vocabulary.service.js'
import { neededVocabulary } from '../src/modules/readings/vocabulary-pool.js'
import { Word } from '../src/modules/words/word.model.js'

const FIXTURE_USER = { rich: 'fixture-rich', thin: 'fixture-thin' }

/**
 * 15 条用例（方案 §3.4.3）。
 *
 * `expect` 不是「我们希望的」，而是**按当前公式算出来的必然结果**，
 * 所以它同时是门槛的回归断言。
 *
 * 与方案原文的差异（已记进 §17）：原文把 #10/#11 的难度写反了——
 * ratio 越大（hard 0.7）需要的词越少，所以 thin 120 词时 hard 能过、easy 会 422。
 */
const CASES = [
  { id: 1, fixture: 'rich', level: 'easy', targetWords: 200, vocabScope: ['all'], expect: 'ok' },
  { id: 2, fixture: 'rich', level: 'medium', targetWords: 200, vocabScope: ['all'], expect: 'ok' },
  { id: 3, fixture: 'rich', level: 'hard', targetWords: 200, vocabScope: ['all'], expect: 'ok' },
  { id: 4, fixture: 'rich', level: 'easy', targetWords: 400, vocabScope: ['all'], expect: 'ok' },
  { id: 5, fixture: 'rich', level: 'medium', targetWords: 400, vocabScope: ['all'], expect: 'ok' },
  { id: 6, fixture: 'rich', level: 'hard', targetWords: 400, vocabScope: ['all'], expect: 'ok' },
  { id: 7, fixture: 'rich', level: 'easy', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
  { id: 8, fixture: 'rich', level: 'medium', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
  { id: 9, fixture: 'rich', level: 'hard', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
  { id: 10, fixture: 'thin', level: 'hard', targetWords: 600, vocabScope: ['all'], expect: 'ok' },
  {
    id: 11,
    fixture: 'thin',
    level: 'easy',
    targetWords: 600,
    vocabScope: ['all'],
    expect: 'VOCABULARY_TOO_SMALL',
  },
  { id: 12, fixture: 'thin', level: 'medium', targetWords: 400, vocabScope: ['all'], expect: 'ok' },
  {
    id: 13,
    fixture: 'rich',
    level: 'medium',
    targetWords: 400,
    vocabScope: ['today_new'],
    expect: 'ok',
  },
  {
    id: 14,
    fixture: 'rich',
    level: 'hard',
    targetWords: 400,
    vocabScope: ['today_reviewed'],
    expect: 'ok',
  },
  { id: 15, fixture: 'rich', level: 'easy', targetWords: 100, vocabScope: ['all'], expect: 'ok' },
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
  const pass = actual === testCase.expect

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

    if (!withArticle && 'article' in record) delete record.article

    rounds.push({ run, durationMs, ...record, ...judged })
    console.log(
      `  #${String(testCase.id).padStart(2)} run${run}  ${String(judged.actual).padEnd(22)}` +
        ` ${String(record.actualWords ?? '-').padStart(2)}词` +
        ` ${String(record.repairRounds ?? '-').padStart(2)}轮` +
        ` ${String(record.poolSize ?? '-').padStart(3)}池` +
        ` ${String(record.totalTokens ?? '-').padStart(5)}tok` +
        ` ${(durationMs / 1000).toFixed(1)}s  ${judged.pass ? '✓' : '✗'}`,
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
    }
  })

  return {
    totalRuns: runs.length,
    expectedRuns: allCases.length * times,
    ok: runs.filter((run) => run.ok).length,
    failed: runs.filter((run) => !run.ok).length,
    judgeFailed: runs.filter((run) => !run.pass).length,
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

async function dryRun(cases, times, base) {
  console.log(`\n[dry-run] base=${base}  times=${times}  用例 ${cases.length} 条\n`)

  for (const fixture of new Set(cases.map((item) => item.fixture))) {
    const userId = FIXTURE_USER[fixture]
    const count = await Word.countDocuments({ userId })
    // 门槛只看能进池的词：new 状态不参与选池（word.repository.js）
    const eligible = await Word.countDocuments({
      userId,
      status: { $in: ['learning', 'mastered'] },
    })
    console.log(`fixture ${fixture}（${userId}）：库里 ${count} 词，可入池 ${eligible} 个`)

    if (count === 0) {
      console.log('  ⚠️ 该用户没有词，先跑 node scripts/seed-test-fixtures.mjs --fixture all')
    }

    for (const testCase of cases.filter((item) => item.fixture === fixture)) {
      const needed = neededVocabulary({
        targetWords: testCase.targetWords,
        level: testCase.level,
      })
      const gate = eligible >= needed ? 'ok' : 'VOCABULARY_TOO_SMALL'

      console.log(
        `  #${String(testCase.id).padStart(2)} ${testCase.level.padEnd(6)} ` +
          `${testCase.targetWords}词 ${testCase.vocabScope.join('+').padEnd(15)}` +
          ` 需要 ${String(needed).padStart(3)} 词 → ${gate.padEnd(22)}` +
          ` 期望 ${testCase.expect}${gate === testCase.expect ? '' : '  ⚠️ 不符'}`,
      )
    }
  }

  console.log('\n[dry-run] 未发起任何请求，未产生费用。')
}

async function main() {
  const base = argValue('base', 'http://127.0.0.1:3100')
  const times = Number(argValue('times', '3'))
  const fixtureArg = argValue('fixture')
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
        `判定不符 ${summary.judgeFailed}｜失败未留痕 ${summary.failureMissing}`,
    )
    console.log(`  errorCode：${JSON.stringify(summary.codes)}`)
    console.log(
      `  候选池不一致的用例：${summary.poolInconsistent.length ? summary.poolInconsistent.join(', ') : '无'}`,
    )

    for (const item of summary.byCase) {
      console.log(
        `  #${String(item.caseId).padStart(2)} ${item.level.padEnd(6)} ${String(item.targetWords).padStart(3)}词` +
          ` ${item.vocabScope.padEnd(15)} 成功 ${item.ok}/${item.runs}` +
          ` 池 ${item.poolSizes.join('/') || '-'} ${item.judgePassed ? '✓' : '✗'}`,
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
