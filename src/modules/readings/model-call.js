import { config } from '../../config/index.js'
import { recordTokenUsage } from '../budget/budget.service.js'
import { recordUsageEvent } from '../usage/token-usage.service.js'
import { chatJson } from './ai.client.js'

/**
 * 调一次模型，并把这一轮的用量记进 rounds。
 *
 * 独立成模块是为了让整篇路径（reading.service）和分段路径（segmented.service）
 * 共用同一套记账口径——两条路径的 rounds 结构一旦分家，A/B 对比就失去意义。
 *
 * 上限固定读 config.maxOutputTokens（默认 8192）。它是**上限不是计费项**：
 * 按实际 completion_tokens 计费，估小了反而会被截断成 AI_INVALID_RESPONSE，
 * 用户看到的是「生成失败」而不是「文章有点长」。
 *
 * @param {{
 *   kind: 'generate'|'repair'|'plan'|'segment'|'finish',
 *   messages: Array,
 *   signal?: AbortSignal,
 *   rounds: Array,
 *   repairFor?: string|null,
 *   temperature?: number,
 *   userId?: string,
 *   taskId?: string|object|null,
 * }} params
 */
export async function callModel({
  kind,
  messages,
  signal,
  rounds,
  repairFor = null,
  temperature = 0.8,
  userId = '',
  taskId = null,
}) {
  const startedAt = Date.now()
  const response = await chatJson({
    messages,
    signal,
    maxTokens: config.maxOutputTokens,
    temperature,
  })
  const usage = response.usage ?? {}
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  // 上游一定给 total_tokens；兜底是为了打桩测试与个别代理不返回这个字段
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens

  rounds.push({
    kind,
    promptTokens,
    completionTokens,
    totalTokens,
    // DeepSeek 会返回，命中前缀缓存的输入单价更低
    cacheHitTokens: usage.prompt_cache_hit_tokens ?? 0,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? 0,
    finishReason: response.finishReason ?? null,
    maxTokens: config.maxOutputTokens,
    durationMs: Date.now() - startedAt,
    // 这一轮是被什么问题催出来的；首轮没有上游原因
    repairFor,
  })

  // 全局免费池按**每一次真实调用**累计（md/36）：失败的文章、被取消的任务、
  // 补段重试花掉的钱都是账单上的钱。不 await：记账不该拖慢生成，
  // 也不该在写库失败时把一次已经付过钱的调用再搞失败
  void recordTokenUsage(totalTokens)

  // 同一次调用再记一条**归属到用户**的流水（md/37 §3.5）。任务触发的带 taskId，
  // 同步 /generate 没有任务所以为 null。两条都 `void`，失败只打日志
  void recordUsageEvent({
    userId,
    taskId,
    kind,
    model: config.deepseekModel,
    promptTokens,
    completionTokens,
    totalTokens,
  })

  return response
}

/** 多轮累加。以前写成 `usage = repaired.usage ?? usage` 是覆盖，前几轮的费用会凭空消失 */
export function sumUsage(rounds) {
  return rounds.reduce(
    (acc, round) => ({
      promptTokens: acc.promptTokens + round.promptTokens,
      completionTokens: acc.completionTokens + round.completionTokens,
      totalTokens: acc.totalTokens + round.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  )
}
