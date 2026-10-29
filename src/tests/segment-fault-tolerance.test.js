import { describe, expect, it, vi } from 'vitest'

/**
 * 段级容错（md/55 §4.6）。
 *
 * 上游单段失败 → 该段 dropped，其它段照常成文；
 * 鉴权 / 参数这类「换一段也没用」的错误必须继续向上抛。
 */
const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }))

vi.mock('../modules/readings/model-call.js', () => ({ callModel }))

const { ApiError, ERROR_CODES } = await import('../shared/errors.js')
const { generateSegmented } = await import('../modules/readings/segmented.service.js')

const SHORT =
  'A good boy has a big book. The boy and his book play in the house. They are good friends.'

const FINISH = {
  title: 'A Good Day',
  translation: '一个男孩有一本很大的书，他和书在房子里玩，他们是好朋友。',
  names: [],
  questions: [],
}

const allowedWords = new Set([
  'a', 'good', 'boy', 'has', 'big', 'book', 'the', 'and', 'his', 'play',
  'in', 'house', 'they', 'are', 'friends',
])

const segments = [
  { id: 1, goal: 'BAD_GOAL 写坏掉的一段', mustUse: [], maxWords: 37, limitWords: 100 },
  { id: 2, goal: '写男孩的书', mustUse: [], maxWords: 37, limitWords: 100 },
  { id: 3, goal: '写他们是朋友', mustUse: [], maxWords: 37, limitWords: 100 },
]

function baseParams(overrides = {}) {
  return {
    segments,
    systemPrompt: 'system',
    allowedWords,
    names: new Set(),
    rounds: [],
    questionCount: 3,
    range: { label: '100' },
    level: 'easy',
    acceptedMax: 300,
    unknownBudget: 0,
    ...overrides,
  }
}

describe('generateSegmented · 段级容错', () => {
  it('单段上游失败只丢这一段，其余段仍成文', async () => {
    const seen = []

    callModel.mockImplementation(async ({ kind, messages }) => {
      if (kind === 'finish') {
        return {
          content: JSON.stringify(FINISH),
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          finishReason: 'stop',
        }
      }

      // 只匹配「本段目标」：全文 outline 也含所有 goal，按 goal 字符串判断会误伤其它段
      if (JSON.stringify(messages).includes('本段目标：BAD_GOAL')) {
        throw new ApiError(502, ERROR_CODES.AI_PROVIDER_ERROR, 'upstream down')
      }

      return {
        content: JSON.stringify({ text: SHORT }),
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        finishReason: 'stop',
      }
    })

    const result = await generateSegmented(baseParams({
      onSegment: (segment) => {
        seen.push(segment)
      },
    }))

    expect(result.data.article.split('\n\n')).toHaveLength(2)
    expect(result.stats.find((item) => item.id === 1)).toMatchObject({
      accepted: false,
      errorCode: ERROR_CODES.AI_PROVIDER_ERROR,
    })
    expect(result.stats.filter((item) => item.accepted)).toHaveLength(2)

    // 丢段也要发 dropped 进度，否则进度条永远差最后一格
    expect(seen.some((item) => item.index === 1 && item.status === 'dropped')).toBe(true)
  })

  it('自备 Key 失效这类错误不能被吞成 dropped', async () => {
    callModel.mockRejectedValue(
      new ApiError(403, ERROR_CODES.USER_API_KEY_INVALID, 'key expired'),
    )

    await expect(
      generateSegmented(baseParams({ segments: [segments[0]] })),
    ).rejects.toMatchObject({ code: ERROR_CODES.USER_API_KEY_INVALID })
  })

  it('客户端 / deadline 取消继续向上抛', async () => {
    const controller = new AbortController()
    controller.abort()

    callModel.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    )

    await expect(
      generateSegmented(baseParams({
        segments: [segments[0]],
        signal: controller.signal,
      })),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
