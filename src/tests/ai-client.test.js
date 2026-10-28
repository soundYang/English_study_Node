import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 上游客户端只测「重试边界」：
 *   超时 → 重试一次；连续两次失败 → 502；4xx 与主动取消 → 不重试。
 * 这些分支决定一次生成是「偶发失败」还是「用户看到 502」，值得单独钉住。
 */
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

const timeoutError = () =>
  Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })

beforeEach(() => {
  create.mockReset()
})

describe('chatJson · 超时重试', () => {
  it('超时后重试一次并成功', async () => {
    create.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(okResponse)

    const result = await chatJson({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })

    expect(create).toHaveBeenCalledTimes(2)
    expect(result.content).toBe('{"a":1}')
    expect(result.finishReason).toBe('stop')
  })

  it('连续两次超时才 502', async () => {
    create.mockRejectedValue(timeoutError())

    await expect(chatJson({ messages: [], maxTokens: 100 })).rejects.toMatchObject({
      status: 502,
      code: 'AI_PROVIDER_ERROR',
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('4xx 说明请求本身有问题，不重试', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }))

    await expect(chatJson({ messages: [], maxTokens: 100 })).rejects.toMatchObject({ status: 502 })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('客户端已取消时不重试，也不改写成 502', async () => {
    const controller = new AbortController()
    controller.abort()
    create.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))

    await expect(
      chatJson({ messages: [], maxTokens: 100, signal: controller.signal }),
    ).rejects.toThrow('aborted')
    expect(create).toHaveBeenCalledTimes(1)
  })
})
