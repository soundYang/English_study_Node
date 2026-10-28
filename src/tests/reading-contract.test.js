import { describe, expect, it } from 'vitest'

import { generateReadingSchema } from '../modules/readings/reading.schema.js'
import {
  ApiError,
  ERROR_CODES,
  knownWordsTooSmall,
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
  // 契约层放开到 800（md/26），各档实际能写多长仍由 LEVEL_LIMITS 决定：
  // easy 请求 800 会过 schema，但被 targetWordsTooLong 拦成 400。
  it('100 与 800 是两个合法端点', () => {
    expect(parse(body({ targetWords: 100 })).success).toBe(true)
    expect(parse(body({ targetWords: 800 })).success).toBe(true)
  })

  it('低于 100 或高于 800 → 400', () => {
    for (const targetWords of [90, 810]) {
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
})

describe('B 门 — 已知词汇量不够', () => {
  it('422，kind=known_words，挂在 level 上，文案给出还差多少个', () => {
    const error = knownWordsTooSmall({ level: 'medium', required: 1900, available: 1758 })

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(422)
    expect(error.code).toBe(ERROR_CODES.VOCABULARY_TOO_SMALL)
    expect(error.field).toBe('level')
    expect(error.details).toEqual({
      kind: 'known_words',
      level: 'medium',
      required: 1900,
      available: 1758,
      shortage: 142,
    })
    // 与界面按钮同一套叫法（进阶 / 挑战），不是「中等 / 困难」
    expect(error.message).toContain('进阶模式需要认识约 1900 个单词')
    expect(error.message).toContain('当前已有 1758 个（还差 142 个）')
    expect(error.message).not.toContain('medium')
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
    })
    expect(error.message).toContain('简单模式最高支持 300 词')
    expect(error.message).toContain('本次请求 400 词')
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
