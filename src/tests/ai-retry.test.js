import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 上游重试与退避（md/55 §4.5）。
 *
 * 退避基数调到 1s，才能在「重试 sleep 期间取消」这条用例里稳定命中 sleep；
 * 其它用例用 Retry-After 的毫秒级值，不依赖真实长等待。
 */
process.env.AI_RETRY_BASE_MS = '1000'
process.env.AI_RETRY_MAX_MS = '1000'

const { create } = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('openai', () => ({
  default: class OpenAI {
    constructor() {
      this.chat = { completions: { create } }
    }
  },
}))

const { chatJson } = await import('../modules/readings/ai.client.js')

const okResponse = {
  choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
}

const upstreamError = (status, headers = null) =>
  Object.assign(new Error(`upstream ${status}`), { status, ...(headers ? { headers } : {}) })

beforeEach(() => {
  create.mockReset()
})

describe('chatJson · 429 / 5xx 退避', () => {
  it('429 带 Retry-After 时等待后重试并成功', async () => {
    create
      .mockRejectedValueOnce(upstreamError(429, { 'retry-after': '0.01' }))
      .mockResolvedValueOnce(okResponse)

    const result = await chatJson({ messages: [], maxTokens: 100 })

    expect(result.content).toBe('{"a":1}')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('500 是可重试错误，重试成功', async () => {
    create
      .mockRejectedValueOnce(upstreamError(500))
      .mockResolvedValueOnce(okResponse)

    await expect(chatJson({ messages: [], maxTokens: 100 })).resolves.toMatchObject({
      content: '{"a":1}',
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('400 是请求本身写错，不重试', async () => {
    create.mockRejectedValueOnce(upstreamError(400))

    await expect(chatJson({ messages: [], maxTokens: 100 })).rejects.toMatchObject({
      status: 502,
      code: 'AI_PROVIDER_ERROR',
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('退避 sleep 期间取消会立刻中断，不再打上游', async () => {
    create.mockRejectedValue(upstreamError(500))
    const controller = new AbortController()

    setTimeout(() => controller.abort(), 20)

    await expect(
      chatJson({ messages: [], maxTokens: 100, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    // 第一次失败后进入 sleep，取消发生在第二次尝试之前
    expect(create).toHaveBeenCalledTimes(1)
  })
})
