import { config } from '../../config/index.js'
import { freeBudgetExhausted } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { FREE_BUDGET_ID, TokenBudget } from './budget.model.js'

/**
 * 全局免费 token 预算（md/36）。
 *
 * 和每日额度（quota）的分工：
 *   · quota   —— 「同一个人一天能用几次」，按账号 / 设备 / 网络计数；
 *   · budget  —— 「这个免费 key 总共还能花多少」，全站一个计数器。
 *
 * 计数发生在**每一次模型调用**（model-call.js），不是每篇文章：
 * 失败的文章、被取消的任务、补段重试花掉的钱都是真实账单，只算成功交付
 * 会明显低估花销，等计数器到 2 亿时实际早就超了。
 */

/** 累加一次调用的 token。开关关闭时不做任何事（测试默认关闭） */
export async function recordTokenUsage(tokens) {
  if (!config.tokenBudgetEnabled) return
  if (!Number.isFinite(tokens) || tokens <= 0) return

  try {
    await increment(tokens)
  } catch (error) {
    // 记账失败不能让一次已经付过钱的模型调用再失败：最多是计数器偏低
    logger.warn({ err: error, tokens }, 'token budget increment failed')
  }
}

async function increment(tokens, retried = false) {
  try {
    await TokenBudget.updateOne(
      { _id: FREE_BUDGET_ID },
      {
        $inc: { usedTokens: tokens },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    )
  } catch (error) {
    // 两个并发请求同时 upsert 同一条文档时，后插入的那个会撞 _id 唯一键。
    // 这不是故障，重试一次就会走 update 分支
    if (error?.code === 11000 && !retried) return increment(tokens, true)

    throw error
  }
}

/** 当前预算状态。开关关闭时按「未耗尽」返回，前端不需要分支 */
export async function getBudgetStatus() {
  const doc = await TokenBudget.findById(FREE_BUDGET_ID).lean()
  const usedTokens = doc?.usedTokens ?? 0
  const limitTokens = config.freeTokenBudget

  return {
    enabled: config.tokenBudgetEnabled,
    limitTokens,
    usedTokens,
    remainingTokens: Math.max(0, limitTokens - usedTokens),
    exhausted: config.tokenBudgetEnabled && usedTokens >= limitTokens,
  }
}

/**
 * 生成开始前的闸门：免费池到顶就拒绝。
 *
 * 放在建任务 / 同步生成 / 重试三个入口，而不是 model-call 里：
 * 任务已经 202 返回之后再失败，前端只能看到「跑到一半停了」。
 *
 * 并发下可能略微超出上限（几个请求同时读到未满），2 亿的量级下可以接受；
 * 真要严格，就得在调用前预扣预估额度，代价是每次生成都要处理预留与回补。
 */
export async function assertBudgetAvailable() {
  if (!config.tokenBudgetEnabled) return

  const status = await getBudgetStatus()
  if (!status.exhausted) return

  throw freeBudgetExhausted(status)
}
