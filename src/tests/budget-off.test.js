import { describe, expect, it } from 'vitest'

import { assertBudgetAvailable, getBudgetStatus, recordTokenUsage } from '../modules/budget/budget.service.js'
import { TokenBudget } from '../modules/budget/budget.model.js'

/**
 * 开关关闭时预算完全透明（md/36 §配置）。
 *
 * 这一条很重要：所有其它测试文件都跑在关闭状态。如果关闭时还在计数或闸门，
 * 要么测试变慢，要么生成接口在测试里莫名其妙 503。
 */
describe('TOKEN_BUDGET_ENABLED=false', () => {
  it('不写计数器', async () => {
    await recordTokenUsage(500)

    expect(await TokenBudget.countDocuments({})).toBe(0)
  })

  it('状态返回 enabled=false，永不 exhausted', async () => {
    expect(await getBudgetStatus()).toMatchObject({
      enabled: false,
      exhausted: false,
      usedTokens: 0,
    })
  })

  it('闸门直接放行（即使计数器上已经超了）', async () => {
    await TokenBudget.create({ _id: 'free-tokens', usedTokens: 999_999_999 })

    await expect(assertBudgetAvailable()).resolves.toBeUndefined()
  })
})
