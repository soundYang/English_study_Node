import { describe, expect, it } from 'vitest'

/**
 * 全局免费 token 预算（md/36）。
 *
 * 纯逻辑：累加、并发、状态、闸门。开关默认在 setup.js 里是关的，
 * 这里先改环境变量再动态 import（同 quota-service.test.js）。
 */
process.env.TOKEN_BUDGET_ENABLED = 'true'
process.env.FREE_TOKEN_BUDGET = '1000'

const { assertBudgetAvailable, getBudgetStatus, recordTokenUsage } = await import(
  '../modules/budget/budget.service.js'
)
const { FREE_BUDGET_ID, TokenBudget } = await import('../modules/budget/budget.model.js')

const used = async () => (await TokenBudget.findById(FREE_BUDGET_ID).lean())?.usedTokens ?? 0

describe('累计', () => {
  it('每次调用累加，第一次会自己建计数器', async () => {
    expect(await used()).toBe(0)

    await recordTokenUsage(100)
    await recordTokenUsage(200)
    await recordTokenUsage(300)

    expect(await used()).toBe(600)
  })

  it('并发累加不丢数（$inc 而不是先读再写）', async () => {
    await Promise.all(Array.from({ length: 10 }, () => recordTokenUsage(100)))

    expect(await used()).toBe(1000)
  })

  it('0 / 负数 / 非数字不写库', async () => {
    await recordTokenUsage(0)
    await recordTokenUsage(-5)
    await recordTokenUsage(undefined)
    await recordTokenUsage(Number.NaN)

    expect(await TokenBudget.countDocuments({})).toBe(0)
  })
})

describe('状态', () => {
  it('未到顶：剩余量正确，exhausted=false', async () => {
    await recordTokenUsage(400)

    expect(await getBudgetStatus()).toEqual({
      enabled: true,
      limitTokens: 1000,
      usedTokens: 400,
      remainingTokens: 600,
      exhausted: false,
    })
  })

  it('到顶与超出：exhausted=true，剩余夹在 0', async () => {
    await recordTokenUsage(1200)

    const status = await getBudgetStatus()
    expect(status.exhausted).toBe(true)
    expect(status.remainingTokens).toBe(0)
  })
})

describe('闸门', () => {
  it('未到顶时放行', async () => {
    await recordTokenUsage(999)
    await expect(assertBudgetAvailable()).resolves.toBeUndefined()
  })

  it('到顶时 503 FREE_BUDGET_EXHAUSTED，并带上限与已用量', async () => {
    await recordTokenUsage(1000)

    await expect(assertBudgetAvailable()).rejects.toMatchObject({
      status: 503,
      code: 'FREE_BUDGET_EXHAUSTED',
      details: { limitTokens: 1000, usedTokens: 1000 },
    })
  })
})
