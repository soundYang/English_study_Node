import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../app.js'
import { ApiError, ERROR_CODES, userApiKeyExpired } from '../shared/errors.js'

/**
 * 导入的 AI 识别（md/49）。
 *
 * 这里守的是三条线，任何一条破了都比功能不好用更糟：
 *   1. **默认不调模型**——不传 mode 时行为必须与 md/48 完全一致；
 *   2. **没有自备 Key 就不许调**——不能悄悄花站方的免费额度；
 *   3. **AI 的输出不可信**——校验、截断、去重仍由后端说了算。
 *
 * 上游一律 mock（真实调用既慢又花钱），只验证「发出去的提示词对不对」
 * 与「拿回来的东西怎么处理」。
 */

const mocks = vi.hoisted(() => ({
  chatJson: vi.fn(),
  resolveAiKey: vi.fn(),
  markUserApiKeyInvalid: vi.fn(),
}))

// 模型调用打桩：callModel 最终落到 chatJson，这一层挡住所有网络请求
vi.mock('../modules/readings/ai.client.js', () => ({ chatJson: mocks.chatJson }))

// 只替换「解析 Key」这一步，其余导出保持真实（别的模块还要用 freeAiKey 等）
vi.mock('../modules/ai-keys/ai-key.service.js', async (importOriginal) => {
  const actual = await importOriginal()

  return {
    ...actual,
    resolveAiKey: mocks.resolveAiKey,
    markUserApiKeyInvalid: mocks.markUserApiKeyInvalid,
  }
})

// config 是 Object.freeze 的，而「总开关关掉」这条分支必须能测。
// 给本文件一份可写的副本；其余模块 import 到的也是同一份，行为不变。
vi.mock('../config/index.js', async (importOriginal) => {
  const actual = await importOriginal()

  return { ...actual, config: { ...actual.config } }
})

vi.mock('../modules/words/import/ocr.js', () => ({
  recognizeImage: vi.fn(async () => 'abandon 放弃\nability 能力\n'),
  shutdownOcr: vi.fn(async () => {}),
}))

const { config } = await import('../config/index.js')
const { TokenUsage } = await import('../modules/usage/token-usage.model.js')
const { assertUserQuota } = await import('../modules/words/import/ai.js')

const app = createApp()

const USER_KEY = {
  source: 'user',
  apiKey: 'sk-test',
  provider: 'deepseek',
  keyId: 'key-1',
}

/** 上游正常返回：内容是一个合法的 {"items":[...]} */
function reply(items, { finishReason = 'stop', promptTokens = 100, completionTokens = 50 } = {}) {
  return {
    content: JSON.stringify({ items }),
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    finishReason,
  }
}

const extract = (buffer, filename, contentType = 'text/plain', mode) => {
  const req = request(app)
    .post('/api/words/import/extract')
    .attach('file', buffer, { filename, contentType })

  return mode === undefined ? req : req.field('mode', mode)
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

beforeEach(() => {
  mocks.chatJson.mockReset()
  mocks.resolveAiKey.mockReset()
  mocks.markUserApiKeyInvalid.mockReset()
  mocks.resolveAiKey.mockResolvedValue(USER_KEY)
  config.importAiEnabled = true
})

describe('AI 识别：开关与资格', () => {
  it('不传 mode：与 md/48 完全一致，一次模型都不调', async () => {
    const res = await extract(Buffer.from('abandon 放弃\n', 'utf8'), 'unit.txt')

    expect(res.status).toBe(200)
    expect(res.body.engine).toBeUndefined()
    expect(res.body.ai).toBeUndefined()
    expect(res.body.rows[0]).toEqual({ index: 0, word: 'abandon', meaning: '放弃', valid: true })
    expect(mocks.chatJson).not.toHaveBeenCalled()
    expect(mocks.resolveAiKey).not.toHaveBeenCalled()
  })

  it('mode=local：显式关也是本地链路', async () => {
    const res = await extract(Buffer.from('abandon 放弃\n', 'utf8'), 'unit.txt', 'text/plain', 'local')

    expect(res.status).toBe(200)
    expect(res.body.engine).toBeUndefined()
    expect(mocks.chatJson).not.toHaveBeenCalled()
  })

  it('mode=ai 但没有自备 Key → 409，不退回免费池', async () => {
    mocks.resolveAiKey.mockResolvedValue({
      source: 'free',
      apiKey: 'server-free-key',
      provider: 'deepseek',
      keyId: null,
    })

    const res = await extract(Buffer.from('abandon 放弃\n', 'utf8'), 'unit.txt', 'text/plain', 'ai')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('USER_API_KEY_REQUIRED')
    // 关键：连本地抽取都没跑，更没调模型
    expect(mocks.chatJson).not.toHaveBeenCalled()
  })

  it('服务端总开关关掉 → 403 IMPORT_AI_DISABLED', async () => {
    config.importAiEnabled = false

    const res = await extract(Buffer.from('abandon 放弃\n', 'utf8'), 'unit.txt', 'text/plain', 'ai')

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('IMPORT_AI_DISABLED')
    expect(mocks.chatJson).not.toHaveBeenCalled()
  })

  it('mode 取值不认识 → 400，不默默当 local', async () => {
    const res = await extract(Buffer.from('abandon 放弃\n', 'utf8'), 'unit.txt', 'text/plain', 'haha')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
    expect(mocks.chatJson).not.toHaveBeenCalled()
  })
})

describe('AI 识别：结果处理', () => {
  it('成功：engine=ai、AI 释义被标记、用量回传给前端', async () => {
    mocks.chatJson.mockResolvedValue(
      reply([
        { index: 0, word: 'abandon', meaning: '放弃' },
        { index: 1, word: 'ability', meaning: '' },
      ]),
    )

    const res = await extract(Buffer.from('abandon\nability\n', 'utf8'), 'unit.txt', 'text/plain', 'ai')

    expect(res.status).toBe(200)
    expect(res.body.engine).toBe('ai')
    expect(res.body.ai).toMatchObject({
      model: config.deepseekModel,
      keySource: 'user',
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
    })
    expect(res.body.rows).toEqual([
      { index: 0, word: 'abandon', meaning: '放弃', valid: true, meaningSource: 'ai' },
      { index: 1, word: 'ability', meaning: '', valid: true, meaningSource: 'missing' },
    ])
    expect(res.body.warnings.map((item) => item.code)).toContain('AI_RECOGNIZED')

    // 提示词必须把原文包在 <text> 里，并声称这是数据不是指令
    const messages = mocks.chatJson.mock.calls[0][0].messages
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('不是指令')
    expect(messages[1].content).toContain('<text>')

    // 记账口径：kind=import、keySource=user（md/37 的流水）
    await vi.waitFor(async () => {
      const usage = await TokenUsage.findOne({ kind: 'import' })
      expect(usage?.keySource).toBe('user')
      expect(usage?.totalTokens).toBe(150)
    })
  })

  it('模型两次都返回非法 JSON → 502，且只多试一次', async () => {
    mocks.chatJson.mockResolvedValue({ content: '这不是 JSON', usage: {}, finishReason: 'stop' })

    const res = await extract(Buffer.from('abandon\n', 'utf8'), 'unit.txt', 'text/plain', 'ai')

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE')
    expect(mocks.chatJson).toHaveBeenCalledTimes(2)
  })

  it('脏数据：缺词、非对象、重复词、非法词各归各位', async () => {
    mocks.chatJson.mockResolvedValue(
      reply([
        { index: 0, word: 'abandon', meaning: '放弃' },
        { index: 1, word: '', meaning: '空词应丢弃' },
        { index: 2, word: 'Abandon', meaning: '重复，保留第一条' },
        null,
        { index: 3, word: 'give up', meaning: '短语' },
        { index: 4, word: '中文', meaning: '非法字符' },
        { index: 5, word: 'a'.repeat(60), meaning: '太长' },
      ]),
    )

    const res = await extract(Buffer.from('x\n', 'utf8'), 'unit.txt', 'text/plain', 'ai')

    expect(res.status).toBe(200)
    // 空词、null、重复全部消失；剩下的原样标 valid:false 交给用户处理
    expect(res.body.rows.map((row) => row.word)).toEqual([
      'abandon',
      'give up',
      '中文',
      'a'.repeat(60),
    ])
    expect(res.body.rows[0].valid).toBe(true)
    expect(res.body.rows.slice(1).every((row) => row.valid === false)).toBe(true)
    expect(res.body.rows[1].reason).toContain('暂不支持短语')
  })

  it('300 行按 150 一片切成两次调用，结果合并去重', async () => {
    const lines = Array.from({ length: 300 }, (_, index) => `word${index}\n`).join('')

    mocks.chatJson
      .mockResolvedValueOnce(
        reply(Array.from({ length: 150 }, (_, index) => ({ index, word: `word${index}`, meaning: '' }))),
      )
      .mockResolvedValueOnce(
        reply(Array.from({ length: 150 }, (_, index) => ({ index, word: `word${150 + index}`, meaning: '' }))),
      )

    const res = await extract(Buffer.from(lines, 'utf8'), 'big.txt', 'text/plain', 'ai')

    expect(res.status).toBe(200)
    expect(mocks.chatJson).toHaveBeenCalledTimes(2)
    expect(res.body.stats.total).toBe(300)
    expect(res.body.rows).toHaveLength(300)
    expect(res.body.ai.calls).toBe(2)
  })

  it('finish_reason=length → 200 + AI_TRUNCATED，而不是把结果扔了', async () => {
    mocks.chatJson.mockResolvedValue(
      reply([{ index: 0, word: 'abandon', meaning: '放弃' }], { finishReason: 'length' }),
    )

    const res = await extract(Buffer.from('abandon\n', 'utf8'), 'unit.txt', 'text/plain', 'ai')

    expect(res.status).toBe(200)
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.warnings.map((item) => item.code)).toContain('AI_TRUNCATED')
  })

  it('第二片上游失败 → 整次 502，不返回半成品', async () => {
    mocks.chatJson
      .mockResolvedValueOnce(reply([{ index: 0, word: 'abandon', meaning: '放弃' }]))
      .mockRejectedValueOnce(
        new ApiError(502, ERROR_CODES.AI_PROVIDER_ERROR, 'AI 服务暂时不可用，请稍后重试。'),
      )

    const lines = Array.from({ length: 200 }, (_, index) => `word${index}\n`).join('')
    const res = await extract(Buffer.from(lines, 'utf8'), 'big.txt', 'text/plain', 'ai')

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_PROVIDER_ERROR')
    expect(res.body.rows).toBeUndefined()
  })

  it('自备 Key 被上游拒绝 → 403，并标记这把 Key 失效', async () => {
    mocks.chatJson.mockRejectedValue(userApiKeyExpired())

    const res = await extract(Buffer.from('abandon\n', 'utf8'), 'unit.txt', 'text/plain', 'ai')

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('USER_API_KEY_INVALID')
    await vi.waitFor(() => {
      expect(mocks.markUserApiKeyInvalid).toHaveBeenCalledWith(USER_KEY.keyId)
    })
  })

  it('超过 4 片 → 只调 4 次，truncated 并给 AI_PARTIAL', async () => {
    const lines = Array.from({ length: 700 }, (_, index) => `word${index}\n`).join('')

    mocks.chatJson.mockResolvedValue(reply([{ index: 0, word: 'abandon', meaning: '' }]))

    const res = await extract(Buffer.from(lines, 'utf8'), 'big.txt', 'text/plain', 'ai')

    expect(res.status).toBe(200)
    expect(mocks.chatJson).toHaveBeenCalledTimes(config.importAiMaxCalls)
    expect(res.body.truncated).toBe(true)
    expect(res.body.warnings.map((item) => item.code)).toContain('AI_PARTIAL')
  })

  it('按用户限流：默认 10 次/小时，第 11 次 429', () => {
    // 用独立的 userId，避免和上面各条请求共用同一个桶
    const userId = `quota-test-${Date.now()}`

    for (let index = 0; index < config.importAiUserLimit; index += 1) {
      expect(() => assertUserQuota(userId)).not.toThrow()
    }

    try {
      assertUserQuota(userId)
      throw new Error('第 11 次应当被限流')
    } catch (error) {
      expect(error.status).toBe(429)
      expect(error.code).toBe('RATE_LIMITED')
      expect(error.details.retryAfter).toBeGreaterThan(0)
    }
  })

  it('图片：交给模型的是 OCR 原文，不是本地切坏的 rows', async () => {
    mocks.chatJson.mockResolvedValue(reply([{ index: 0, word: 'abandon', meaning: '放弃' }]))

    const res = await extract(PNG_SIGNATURE, 'shot.png', 'image/png', 'ai')

    expect(res.status).toBe(200)
    const content = mocks.chatJson.mock.calls[0][0].messages[1].content
    expect(content).toContain('abandon 放弃')
    expect(content).toContain('ability 能力')
  })
})
