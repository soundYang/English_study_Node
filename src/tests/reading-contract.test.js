import { describe, expect, it } from 'vitest'

import { generateReadingSchema } from '../modules/readings/reading.schema.js'
import { ApiError, ERROR_CODES, vocabularyTooSmall } from '../shared/errors.js'
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
  it('100 与 600 是两个合法端点', () => {
    expect(parse(body({ targetWords: 100 })).success).toBe(true)
    expect(parse(body({ targetWords: 600 })).success).toBe(true)
  })

  it('低于 100 或高于 600 → 400', () => {
    for (const targetWords of [90, 610]) {
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
    expect(vocabularyTooSmall(payload).details).toEqual(payload)
  })

  it('提示语用中文难度名，并算出差额', () => {
    const { message } = vocabularyTooSmall(payload)

    expect(message).toContain('困难模式')
    expect(message).toContain('还差 70 个')
    expect(message).not.toContain('hard')
  })

  it('词比门槛多时差额不会变成负数', () => {
    expect(vocabularyTooSmall({ ...payload, available: 500 }).message).toContain('还差 0 个')
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
})
