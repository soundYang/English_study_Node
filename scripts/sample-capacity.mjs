#!/usr/bin/env node
/**
 * 容量采样：写一篇 N 词的文章，至少要认识多少个词（md/27 §4）。
 *
 * 为什么不走 HTTP：这个采样要跨很多个 fixture（每个 V 点一个用户），
 * 而 `DEFAULT_USER_ID` 是启动参数——走 HTTP 就得为每个 V 重启一次实例。
 * 这里直接调 `generateReading({ userId, body })`，用的仍是线上同一条服务链路，
 * 只是省掉了「起服务器 → 传 userId → 停服务器」这一圈。
 *
 * 判定口径（md/27 §1.2）：同一组参数跑 `--times` 次，
 * 实际词数落在 `[0.85N, 1.15N]` 的比例 ≥ 80% 才算「解锁 N 词」。
 * 注意这只是**一次 HTTP 调用**的成功，生成失败（502）同样计入分母。
 *
 * 前置：
 *   node scripts/seed-test-fixtures.mjs --fixture real-v50
 *   node scripts/seed-test-fixtures.mjs --fixture real-v100
 *   …（每个 V 点都要 seed 一次，或用 --fixture all）
 *
 * 用法：
 *   SKIP_KNOWN_WORDS_GATE=true node scripts/sample-capacity.mjs --n 200 --dry-run
 *   SKIP_KNOWN_WORDS_GATE=true node scripts/sample-capacity.mjs --n 200 --times 3
 *   SKIP_KNOWN_WORDS_GATE=true node scripts/sample-capacity.mjs --n 600 --fixtures real-v200,real-v400
 *
 * ⚠️ 每条成功样本都是一次真实付费调用。先 --dry-run 看池子和 A 门，
 * 再决定跑哪几个点。
 */
import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { GenerationFailure } from '../src/modules/readings/generation-failure.model.js'
import { generateReading } from '../src/modules/readings/reading.service.js'
import { Reading } from '../src/modules/readings/reading.model.js'
import { neededVocabulary, requiredTargetWords } from '../src/modules/readings/vocabulary-pool.js'
import { Word } from '../src/modules/words/word.model.js'

/**
 * V 点 → fixture 名。V 是个人词数，全部是「从最高频开始取 V 个」的真人形态。
 * 顺序固定：从少到多，找到第一个达标点就能停（少花钱）。
 */
const FIXTURES = ['real-v50', 'real-v100', 'real-v200', 'real-v400', 'real-v600', 'real-v800']

/**
 * 统一用 hard 采样，理由见 md/27 §4.1：
 * 删掉 B 门之后「难度」只影响语言复杂度，不再影响门槛；一张表必须对最难的档也成立，
 * 否则用户拿 easy 的实测数去点 hard 就会失败。
 */
const DEFAULT_LEVEL = 'hard'

/** 验收区间与线上同源：`classifyLength` 用 ±15%，这里只做判定不改代码 */
const LOWER = 0.85
const UPPER = 1.15

const QUESTION_COUNT = 3
const RUN_TIMEOUT_MS = 300_000

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

const userIdOf = (fixture) => `fixture-${fixture}`

/** 只统计进正文的段，以及补段救回来的那些 */
function segmentSummary(doc) {
  const segments = doc.aiMeta?.segments ?? []
  return {
    total: segments.length,
    accepted: segments.filter((item) => item.accepted).length,
    dropped: segments.filter((item) => !item.accepted).length,
    refilled: segments.filter((item) => item.refilled).length,
    attempts: segments.reduce((acc, item) => acc + (item.attempts ?? 0), 0),
  }
}

async function runOnce({ userId, level, targetWords }) {
  const startedAt = Date.now()

  try {
    const dto = await generateReading({
      userId,
      body: { level, targetWords, vocabScope: ['all'], questionCount: QUESTION_COUNT },
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    })

    // generateReading 返回的是 safe DTO，aiMeta 不在里面（那是排查字段，不对外）。
    // 采样要看的段明细、池子、token 全在库里，必须回读一次。
    const stored = await Reading.findById(dto.id).lean()
    const deviation = stored.actualWords / targetWords

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      readingId: String(stored._id),
      actualWords: stored.actualWords,
      deviation,
      inRange: deviation >= LOWER && deviation <= UPPER,
      lengthStatus: stored.aiMeta?.lengthStatus ?? null,
      knownWords: stored.aiMeta?.knownWords ?? null,
      requiredKnown: stored.aiMeta?.requiredKnown ?? null,
      poolSize: stored.aiMeta?.candidatePoolSize ?? null,
      requiredWords: stored.aiMeta?.requiredWords ?? null,
      targetCoverage: stored.aiMeta?.targetUsage?.coverageRate ?? null,
      segments: segmentSummary(stored),
      repairRounds: stored.aiMeta?.repairRounds ?? null,
      totalTokens: stored.aiMeta?.totalTokens ?? null,
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, errorCode: 'TIMEOUT', error: `超过 ${RUN_TIMEOUT_MS / 1000}s`, durationMs: Date.now() - startedAt }
    }

    // 服务层保证业务异常都会留一条 GenerationFailure，把它的数字带回来，
    // 否则「A 门拦下」和「模型写崩」在报告里长一个样
    const failure = await GenerationFailure.findOne({ userId, createdAt: { $gte: new Date(startedAt - 2_000) } })
      .sort({ createdAt: -1 })
      .lean()

    return {
      ok: false,
      errorCode: error?.code ?? 'UNKNOWN',
      message: error?.message ?? String(error),
      durationMs: Date.now() - startedAt,
      knownWords: failure?.knownWords ?? null,
      requiredKnown: failure?.requiredKnown ?? null,
      poolSize: failure?.poolSize ?? null,
      available: failure?.available ?? null,
      requiredWords: failure?.requiredWords ?? null,
      totalTokens: failure?.totalTokens ?? null,
      finalUnknownWords: (failure?.finalUnknownWords ?? []).slice(0, 20),
    }
  }
}

async function inspectFixture(fixture, { level, targetWords }) {
  const userId = userIdOf(fixture)
  const words = await Word.find({ userId }).lean()
  const eligible = words.filter((item) => item.status !== 'new')
  const needed = neededVocabulary({ targetWords, level })

  return {
    fixture,
    userId,
    total: words.length,
    eligible: eligible.length,
    needed,
    // 全局下限：个人词库不足 VOCABULARY_THRESHOLD（默认 20）时，
    // 生成入口在 A 门之前就 422。它和 A 门是两道不同的门，
    // 小 V 点（如 100 词的 A 门边界 15）会被它拦下，dry-run 必须看得见。
    belowVocabularyFloor: eligible.length < config.vocabularyThreshold,
    vocabularyThreshold: config.vocabularyThreshold,
    // A 门不过就永远走不到模型。这条要单独标出来，
    // 否则报告里会和「模型写不出来」混为一谈
    aGateBlocked: eligible.length < needed,
    requiredWords: requiredTargetWords(targetWords),
  }
}

async function main() {
  const targetWords = Number(argValue('n', '200'))
  const level = argValue('level', DEFAULT_LEVEL)
  const times = Number(argValue('times', '3'))
  const fixtureArg = argValue('fixtures')
  const anchors = fixtureArg ? fixtureArg.split(',').map((item) => item.trim()) : FIXTURES
  const dryRun = hasFlag('dry-run')
  const out = argValue('out', `samples/capacity_N${targetWords}.json`)

  // 上限 1000 = 最终模式的封顶（md/30 §2.1）。超过 800 的点必须同时带
  // `MAX_TARGET_WORDS=1000`，否则会被档位上限拦成 400 target_words_cap。
  if (!Number.isInteger(targetWords) || targetWords < 50 || targetWords > 1000) {
    throw new Error(`--n 必须在 50–1000 之间，收到 ${targetWords}`)
  }
  if (!Number.isInteger(times) || times < 1) throw new Error('--times 必须是正整数')

  // 采样必须在「跳过 B 门」的配置下跑，否则低于门槛的点全部 422，
  // 测出来的是门槛本身。与其让采样静默失败，不如直接拒绝启动。
  if (!config.skipKnownWordsGate && !dryRun) {
    throw new Error('采样需要 SKIP_KNOWN_WORDS_GATE=true（否则低于 B 门的点全部被拦）')
  }

  await mongoose.connect(config.mongodbUri)
  console.log(`mongo connected: ${mongoose.connection.name}`)
  console.log(
    `\n[${new Date().toISOString()}] 篇幅 ${targetWords} 词｜难度 ${level}｜` +
      `每组 ${times} 次｜跳过 B 门：${config.skipKnownWordsGate ? '是' : '否'}${dryRun ? '｜dry-run' : ''}\n`,
  )

  try {
    const plan = []

    for (const fixture of anchors) {
      plan.push(await inspectFixture(fixture, { level, targetWords }))
    }

    console.log('前置检查（两道门：全局词库下限 → A 门能不能凑齐目标词）')
    for (const item of plan) {
      const status = item.belowVocabularyFloor
        ? `全局下限拦下（${item.eligible} < ${item.vocabularyThreshold}）`
        : item.aGateBlocked
          ? `A 门拦下（${item.eligible} < ${item.needed}）`
          : `可跑，池 ${item.eligible}，目标词 ${item.requiredWords}`
      console.log(`  ${item.fixture.padEnd(11)} ${String(item.eligible).padStart(5)} 词 → ${status}`)
    }

    if (dryRun) {
      console.log('\n[dry-run] 未发起任何请求，未产生费用。')
      return
    }

    const results = []

    for (const item of plan) {
      if (item.belowVocabularyFloor || item.aGateBlocked) {
        results.push({
          ...item,
          runs: [],
          note: item.belowVocabularyFloor
            ? `全局词库下限拦下（${item.eligible} < ${item.vocabularyThreshold}），未调模型`
            : 'A 门拦下，未调模型',
        })
        continue
      }

      console.log(`\n—— ${item.fixture}（${item.userId}，${item.eligible} 词）——`)
      const runs = []

      for (let run = 1; run <= times; run += 1) {
        const record = await runOnce({ userId: item.userId, level, targetWords })
        runs.push(record)

        const head = record.ok
          ? `${String(record.actualWords).padStart(3)}词 ${(record.deviation * 100).toFixed(0).padStart(3)}%`
          : `✗ ${record.errorCode}`
        console.log(
          `  run${run}  ${head.padEnd(14)}` +
            ` 段 ${record.segments ? `${record.segments.accepted}/${record.segments.total}` : '-'}` +
            ` 补 ${record.segments?.refilled ?? '-'}` +
            ` 池 ${String(record.poolSize ?? '-').padStart(3)}` +
            ` 已知 ${String(record.knownWords ?? '-').padStart(4)}` +
            ` ${String(record.totalTokens ?? '-').padStart(5)}tok` +
            `${record.ok ? (record.inRange ? ' ✓' : ' ⚠️篇幅') : ''}`,
        )
      }

      const passed = runs.filter((run) => run.ok && run.inRange).length
      console.log(`  达标 ${passed}/${runs.length}（判定线：≥ ${Math.ceil(runs.length * 0.8)}）`)

      results.push({ ...item, runs, passed, met: passed >= Math.ceil(runs.length * 0.8) })
    }

    const payload = {
      startedAt: new Date().toISOString(),
      targetWords,
      level,
      times,
      model: config.deepseekModel,
      skipKnownWordsGate: config.skipKnownWordsGate,
      results,
    }

    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(payload, null, 2))
    console.log(`\n结果已写入 ${out}`)

    console.log('\n汇总')
    for (const item of results) {
      const words = item.runs.filter((run) => run.ok).map((run) => run.actualWords)
      console.log(
        `  ${item.fixture.padEnd(11)} 已知 ${String(item.runs[0]?.knownWords ?? item.eligible + 618).padStart(4)}` +
          `  达标 ${item.passed ?? 0}/${item.runs.length}` +
          `  ${words.length ? `词数 ${words.join(' / ')}` : (item.note ?? '-')}` +
          `  ${item.met ? '✓ 解锁' : '✗'}`,
      )
    }
  } finally {
    await mongoose.disconnect()
  }
}

main().catch(async (error) => {
  console.error('[sample-capacity] 失败：', error.message)
  process.exitCode = 1
  await mongoose.disconnect().catch(() => {})
})
