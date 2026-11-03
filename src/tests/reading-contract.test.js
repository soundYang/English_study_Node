import { describe, expect, it } from 'vitest'

import { generateReadingSchema } from '../modules/readings/reading.schema.js'
import {
  ApiError,
  ERROR_CODES,
  finalModeLocked,
  knownWordsBelowLength,
  targetWordsTooLong,
  vocabularyTooSmall,
} from '../shared/errors.js'
import { errorHandler } from '../shared/middleware/errorHandler.js'

/**
 * 契约层测试：只测「请求能不能进来」和「错误长什么样」。
 * 不走 HTTP、不调 AI——这两件事在 readings.test.js 和后续的集成用例里覆盖。
 */

const parse = (body) => generateReadingSchema.safeParse(body)
const body = (extra = {}) => ({ level: 'easy', targetWords: 100, questionCount: 3, ...extra })

/** 极简 res 替身：只记录 status 和 json 的入参 */
function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code
      return res
    },
    json(payload) {
      res.body = payload
      return res
    },
  }

  return res
}

describe('generateReadingSchema — 篇幅范围', () => {
  // 契约层放开到 1000（md/30 §2：hard 的最终模式上限），各档实际能写多长
  // 仍由 LEVEL_LIMITS 决定：easy 请求 800 会过 schema，但被
  // targetWordsTooLong 拦成 400；700 以上还要过「个人词库 ≥ 3000」的解锁检查。
  it('100 与 1000 是两个合法端点', () => {
    expect(parse(body({ targetWords: 100 })).success).toBe(true)
    expect(parse(body({ targetWords: 1000 })).success).toBe(true)
  })

  it('低于 100 或高于 1000 → 400', () => {
    for (const targetWords of [90, 1010]) {
      const result = parse(body({ targetWords }))
      expect(result.success).toBe(false)
      expect(result.error.issues[0].path[0]).toBe('targetWords')
    }
  })
})

describe('generateReadingSchema — vocabScope', () => {
  it('不传时默认全选', () => {
    expect(parse(body()).data.vocabScope).toEqual(['all'])
  })

  it('合法取值原样保留，归一化留给 vocabulary-pool', () => {
    const result = parse(body({ vocabScope: ['today_new', 'today_reviewed'] }))

    expect(result.success).toBe(true)
    expect(result.data.vocabScope).toEqual(['today_new', 'today_reviewed'])
  })

  it('reviewing 是合法词源', () => {
    const result = parse(body({ vocabScope: ['reviewing'] }))

    expect(result.success).toBe(true)
    expect(result.data.vocabScope).toEqual(['reviewing'])
  })

  it('显式传空数组 → 400，且 field 指向 vocabScope', () => {
    const result = parse(body({ vocabScope: [] }))

    expect(result.success).toBe(false)
    expect(result.error.issues[0].path[0]).toBe('vocabScope')
    expect(result.error.issues[0].message).toContain('不能为空数组')
  })

  it('非法取值 → 400', () => {
    expect(parse(body({ vocabScope: ['bogus'] })).success).toBe(false)
    expect(parse(body({ vocabScope: 'all' })).success).toBe(false)
  })
})

describe('vocabularyTooSmall', () => {
  const payload = {
    required: 115,
    available: 45,
    requiredWords: 80,
    targetWords: 800,
    scope: ['all'],
    level: 'hard',
  }

  it('是 422，挂在 targetWords 上', () => {
    const error = vocabularyTooSmall(payload)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(422)
    expect(error.code).toBe(ERROR_CODES.VOCABULARY_TOO_SMALL)
    expect(error.field).toBe('targetWords')
  })

  it('details 带全部四个数字，前端不用自己推', () => {
    // kind 区分 A 门（凑不齐目标词）与 B 门（已知词不够），其余数字原样透传
    expect(vocabularyTooSmall(payload).details).toEqual({ kind: 'target_words', ...payload })
  })

  it('提示语用中文难度名，并算出差额', () => {
    const { message } = vocabularyTooSmall(payload)

    expect(message).toContain('挑战模式')
    expect(message).toContain('还差 70 个')
    expect(message).not.toContain('hard')
  })

  it('词比门槛多时差额不会变成负数', () => {
    expect(vocabularyTooSmall({ ...payload, available: 500 }).message).toContain('还差 0 个')
  })

  it('触发兜底后 details 带 fallback，文案说明已经尝试补充', () => {
    const fallback = {
      used: true,
      requestedScope: ['today_new'],
      scopeAvailable: 3,
      allAvailable: 3,
      needed: 29,
      supplemented: 0,
      message: '「今天新学」只有 3 个可用词，不够本次篇幅（至少需要 29 个）；「全部词汇」也没有更多可用词，仍差 26 个。',
    }
    const error = vocabularyTooSmall({ ...payload, fallback })

    expect(error.details.fallback).toEqual(fallback)
    expect(error.message).toContain('已尝试从「全部词汇」补充，仍然不够')
  })

  it('没有触发兜底时 details 不出现 fallback', () => {
    expect(vocabularyTooSmall(payload).details).not.toHaveProperty('fallback')
  })
})

describe('篇幅门槛 — 已知词不够写这么长（md/30 §7.4）', () => {
  it('422，kind=known_words，挂在 targetWords 上，文案给出差额', () => {
    const error = knownWordsBelowLength({
      level: 'medium',
      targetWords: 400,
      required: 1200,
      available: 658,
    })

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(422)
    expect(error.code).toBe(ERROR_CODES.VOCABULARY_TOO_SMALL)
    // 门槛随篇幅走，用户能做的动作是缩篇幅 → 挂在 targetWords 而不是 level 上
    expect(error.field).toBe('targetWords')
    expect(error.details).toEqual({
      kind: 'known_words',
      level: 'medium',
      targetWords: 400,
      required: 1200,
      available: 658,
      shortage: 542,
    })
    // 与界面按钮同一套叫法（进阶 / 挑战），不是「中等 / 困难」
    expect(error.message).toContain('写 400 词的文章需要认识约 1200 个单词')
    expect(error.message).toContain('当前已有 658 个（还差 542 个）')
    expect(error.message).toContain('请缩短篇幅，或添加更多单词')
    expect(error.message).not.toContain('medium')
  })
})

describe('最终模式未解锁', () => {
  it('400，kind=final_mode_locked，口径写清是个人词库而不是 knownWords', () => {
    const error = finalModeLocked({ targetWords: 800, available: 1200, unlockAt: 3000 })

    expect(error.status).toBe(400)
    expect(error.code).toBe(ERROR_CODES.INVALID_REQUEST)
    expect(error.field).toBe('targetWords')
    expect(error.details).toEqual({
      kind: 'final_mode_locked',
      targetWords: 800,
      metric: 'personal_words',
      unlockAt: 3000,
      available: 1200,
      shortage: 1800,
    })
    expect(error.message).toContain('需要个人词库里有 3000 个单词才能解锁')
    expect(error.message).toContain('当前有 1200 个（还差 1800 个）')
  })
})

describe('篇幅门 — 该难度不支持这么长', () => {
  it('400，kind=target_words_cap，文案说明上限与本次请求', () => {
    const error = targetWordsTooLong({ level: 'easy', targetWords: 400, maxTargetWords: 300 })

    expect(error.status).toBe(400)
    expect(error.code).toBe(ERROR_CODES.INVALID_REQUEST)
    expect(error.field).toBe('targetWords')
    expect(error.details).toEqual({
      kind: 'target_words_cap',
      level: 'easy',
      targetWords: 400,
      maxTargetWords: 300,
      finalModeUnlocked: false,
    })
    expect(error.message).toContain('简单模式最高支持 300 词')
    expect(error.message).toContain('本次请求 400 词')
  })

  it('已解锁时不再提示「提高难度」——hard 已经是最高档', () => {
    const error = targetWordsTooLong({
      level: 'hard',
      targetWords: 1200,
      maxTargetWords: 1000,
      finalModeUnlocked: true,
    })

    expect(error.message).not.toContain('提高难度')
    expect(error.details.finalModeUnlocked).toBe(true)
  })
})

describe('errorHandler — details 透传', () => {
  it('有 details 时出现在响应体里', () => {
    const res = fakeRes()

    errorHandler(vocabularyTooSmall({
      required: 115,
      available: 45,
      requiredWords: 80,
      targetWords: 800,
      scope: ['all'],
      level: 'hard',
    }), {}, res, () => {})

    expect(res.statusCode).toBe(422)
    expect(res.body.error.code).toBe(ERROR_CODES.VOCABULARY_TOO_SMALL)
    expect(res.body.error.details).toEqual({
      kind: 'target_words',
      required: 115,
      available: 45,
      requiredWords: 80,
      targetWords: 800,
      scope: ['all'],
      level: 'hard',
    })
  })

  it('没有 details 时响应体里不出现这个键', () => {
    const res = fakeRes()

    errorHandler(new ApiError(400, ERROR_CODES.INVALID_REQUEST, '参数不对', 'level'), {}, res, () => {})

    expect(res.body.error).not.toHaveProperty('details')
    expect(res.body.error.field).toBe('level')
  })

  it('业务错误带回 requestId，与日志里的 req.id 同源', () => {
    const res = fakeRes()

    errorHandler(
      new ApiError(422, ERROR_CODES.VOCABULARY_VALIDATION_FAILED, '生词太多'),
      { id: 'req-abc' },
      res,
      () => {},
    )

    // 前端 ServerError 读的就是 response.data.requestId（English_vue/md/13 C3）
    expect(res.body.requestId).toBe('req-abc')
  })

  it('500 也带回 requestId', () => {
    const res = fakeRes()

    errorHandler(
      new Error('boom'),
      { id: 'req-500', log: { error() {} } },
      res,
      () => {},
    )

    expect(res.statusCode).toBe(500)
    expect(res.body.requestId).toBe('req-500')
  })
})
