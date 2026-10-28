import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { replayAll } from '../../scripts/lib/replay-core.mjs'
import { config } from '../config/index.js'
import { basicWords } from '../modules/readings/basic-words.js'

/**
 * 离线回放：拿库里已经生成过的正文，跑当前校验链路。
 *
 * 这个文件存在的唯一目的，是把「改完之后才发现改坏了别的样本」
 * 从几分钟 + ¥1.7 变成几秒 + 0 元。它不调模型、不连库。
 *
 * 夹具由 `npm run fixtures:export` 生成，金标准由 `npm run replay:update` 生成。
 * 两者缺失时整组跳过——不能让没导过夹具的环境跑不了 `npm test`。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = join(ROOT, 'samples/replay/fixtures.json')
const EXPECTED = join(ROOT, 'samples/replay/expected.json')
const ready = existsSync(FIXTURES) && existsSync(EXPECTED)

describe.skipIf(!ready)('离线回放夹具', () => {
  const fixtures = ready ? JSON.parse(readFileSync(FIXTURES, 'utf8')) : null
  const expected = ready ? JSON.parse(readFileSync(EXPECTED, 'utf8')) : null
  const { results, skipped } = ready
    ? replayAll(fixtures, basicWords, config.maxUnknownWords)
    : { results: [], skipped: [] }

  it('夹具不是空的（导出脚本真的跑过）', () => {
    expect(results.length).toBeGreaterThan(0)
    expect(fixtures.cases.length).toBe(results.length + skipped.length)
  })

  it('每一篇的 counts 之和等于 violations 条数', () => {
    for (const result of results) {
      const sum = Object.values(result.counts ?? {}).reduce((acc, count) => acc + count, 0)
      expect(sum, `${result.id} 的分类计数与违规条数不一致`).toBe(result.violationCount)
    }
  })

  it('withinBudget 由 unknownCount 唯一决定，不受其他状态影响', () => {
    for (const result of results) {
      expect(result.withinBudget, result.id).toBe(result.unknownCount <= config.maxUnknownWords)
    }
  })

  it('历史成功样本的结构在现版本下仍然合法', () => {
    const invalid = results.filter(
      (result) => result.source === 'reading' && result.structure !== 'ok',
    )

    expect(invalid.map((result) => result.id)).toEqual([])
  })

  it('与金标准逐条一致（表外词数 / 分类 / 结构 / 实际词数）', () => {
    const previous = new Map(expected.results.map((item) => [item.id, item]))

    for (const result of results) {
      const before = previous.get(result.id)

      expect(before, `${result.id} 不在金标准里`).toBeTruthy()
      expect(
        {
          unknownCount: result.unknownCount,
          counts: result.counts,
          structure: result.structure,
          actualWords: result.actualWords,
        },
        `${result.id} 与金标准不一致`,
      ).toEqual({
        unknownCount: before.unknownCount,
        counts: before.counts,
        structure: before.structure,
        actualWords: before.actualWords,
      })
    }
  })
})
