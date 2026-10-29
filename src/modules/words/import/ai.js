import { config } from '../../../config/index.js'
import {
  ERROR_CODES,
  ApiError,
  importAiDisabled,
  importAiTimeout,
  userApiKeyRequired,
} from '../../../shared/errors.js'
import { canonicalWord } from '../../../shared/utils/word-form.js'
import { resolveAiKey } from '../../ai-keys/ai-key.service.js'
import { callModel, sumUsage } from '../../readings/model-call.js'
import { buildMessages, buildRepairMessages, parseItems } from './ai.prompt.js'
import { MAX_IMPORT_ROWS } from './limits.js'

/**
 * 导入的 AI 识别（md/49）。
 *
 * 边界很硬：
 *   · **默认关闭**——只有请求显式 `mode=ai` 才会走到这里；
 *   · **只对自备 Key 生效**——`resolveAiKey().source !== 'user'` 直接 409，
 *     绝不回退免费池（那等于站方替用户付钱）；
 *   · AI 的输出只是「候选行」，校验、截断、写库仍走原来那一套。
 *
 * 这里不做任何文件解析：传进来的 `extracted` 是本地抽取器的结果，
 * 图片 / 纯文本用它的原文，docx / xlsx 用它已经排好的行。
 */

/** 少于这个预算就不再发起新的一片：发出去也大概率超时，白烧 token */
const MIN_CHUNK_BUDGET_MS = 5_000

/** 按用户的滑动窗口（单实例尽力而为，多实例时实际额度会放大） */
const quotaBuckets = new Map()
const QUOTA_WINDOW_MS = 60 * 60 * 1000

/**
 * L1 + L2：开关与账号资格。
 *
 * 放在**本地抽取之前**调用：没有资格就没必要解压 Word、跑 OCR，
 * 用户也能更快看到「去接入 Key」的提示。
 *
 * @returns {Promise<{source:'user', apiKey:string, provider:string, keyId:string}>}
 */
export async function prepareAiImport(userId) {
  if (!config.importAiEnabled) throw importAiDisabled()

  const aiKey = await resolveAiKey(userId)

  // resolveAiKey 在用户没接自备 Key 时会返回**免费 Key**，
  // 所以判定必须是 source === 'user'，不能写成「能拿到 Key 就行」
  if (aiKey.source !== 'user') throw userApiKeyRequired()

  return aiKey
}

/**
 * @param {{
 *   source: string,
 *   buffer: Buffer,
 *   extracted: { rows: Array<{word:string, meaning:string}>, text?: string },
 *   userId: string,
 *   aiKey: { source:'user', apiKey:string, keyId:string|null },
 * }} params
 */
export async function recognizeWithAi({ source, buffer, extracted, userId, aiKey }) {
  assertUserQuota(userId)

  const input = toInput({ source, buffer, extracted })
  const planned = planChunks(input)

  const warnings = []
  let truncated = false

  let chunks = planned

  if (chunks.length > config.importAiMaxCalls) {
    // 不是「失败」，是「只看了一部分」：返回前 N 片的结果 + 明确提示
    chunks = chunks.slice(0, config.importAiMaxCalls)
    truncated = true
    warnings.push({
      code: 'AI_PARTIAL',
      message: `内容较多，只分析了前 ${config.importAiMaxCalls} 段；请拆分文件后再导入剩余的`,
    })
  }

  const deadline = Date.now() + config.importAiTimeoutMs
  const rounds = []
  const items = []
  const seen = new Set()
  let calls = 0

  for (let index = 0; index < chunks.length; index += 1) {
    const remaining = deadline - Date.now()

    if (remaining < MIN_CHUNK_BUDGET_MS) {
      // 一条都没拿到 → 整体失败；已经拿到一部分 → 返回部分结果
      if (items.length === 0) throw importAiTimeout()

      truncated = true
      warnings.push({
        code: 'AI_PARTIAL',
        message: '剩余内容没来得及分析，结果可能不完整；建议拆分文件后再试',
      })
      break
    }

    const result = await callChunk({
      chunk: chunks[index],
      index,
      total: chunks.length,
      rounds,
      userId,
      aiKey,
      deadline,
    })

    calls += result.calls

    if (result.finishReason === 'length') {
      // 输出被 max_tokens 截断：这一片的后半部分没了，但前半部分仍然可用
      warnings.push({
        code: 'AI_TRUNCATED',
        message: 'AI 输出被截断，这一部分可能不完整；建议拆分文件后再试',
      })
    }

    for (const item of result.items) {
      const key = canonicalWord(item.word)

      if (!key || seen.has(key)) continue

      seen.add(key)
      items.push({ word: item.word, meaning: item.meaning })
    }
  }

  const usage = sumUsage(rounds)

  return {
    items,
    truncated: truncated || items.length > MAX_IMPORT_ROWS,
    warnings,
    calls,
    usage: {
      // 模型名不来自模型返回，避免上游乱报；token 数是真实计费口径
      model: config.deepseekModel,
      keySource: 'user',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    },
  }
}

/**
 * 一次分片调用：解析失败时**只多试一次**。
 *
 * 不加第二次修复轮：连续两次格式错误说明这次上游状态不对，
 * 再试只会继续烧用户的钱，前端还有「重试」按钮。
 */
async function callChunk({ chunk, index, total, rounds, userId, aiKey, deadline }) {
  const messages = buildMessages({ ...chunk, index, total })

  const first = await invoke({ messages, rounds, userId, aiKey, deadline })

  try {
    return { ...first, items: parseItems(first.content), calls: 1 }
  } catch (error) {
    if (error?.code !== ERROR_CODES.AI_INVALID_RESPONSE) throw error

    // 修复轮共用同一个总预算：不能因为「多试一次」把整次请求拖过 45s
    const repaired = await invoke({
      messages: buildRepairMessages(messages, first.content),
      rounds,
      userId,
      aiKey,
      deadline,
    })

    return { ...repaired, items: parseItems(repaired.content), calls: 2 }
  }
}

async function invoke({ messages, rounds, userId, aiKey, deadline }) {
  const timeoutMs = Math.min(config.deepseekTimeoutMs, deadline - Date.now())

  if (timeoutMs < 1_000) throw importAiTimeout()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await callModel({
      kind: 'import',
      messages,
      signal: controller.signal,
      rounds,
      // 抽取任务不需要创造力；低温度能明显压低「编造释义」
      temperature: 0.1,
      userId,
      aiKey,
    })

    return { content: response.content, finishReason: response.finishReason }
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) throw importAiTimeout()

    throw error
  } finally {
    clearTimeout(timer)
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'APIUserAbortError'
}

/** 按来源决定给模型什么：原文用于「本地切坏了」的情况，行用于「结构本来就对」的情况 */
function toInput({ source, buffer, extracted }) {
  if (source === 'docx' || source === 'xlsx') {
    return {
      kind: 'rows',
      text: extracted.rows
        .map((row) => `${row.word}\t${row.meaning ?? ''}`.trim())
        .join('\n'),
    }
  }

  if (source === 'image') {
    // 图片必须用 OCR 的**原始文本**：rows 是本地按坏规则切过的，
    // 把切坏的结果再交给模型，等于让它在一份错的数据上纠错
    return { kind: 'text', text: extracted.text ?? '' }
  }

  // txt / csv：直接用文件原文，保留用户原本的分隔与编号，让模型自己判断
  return { kind: 'text', text: buffer.toString('utf8').replace(/^﻿/, '') }
}

/** 按行切，同时受「行数」和「字符数」两个上限约束 */
function planChunks(input) {
  const lines = String(input.text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const chunks = []
  let buffer = []
  let chars = 0

  const flush = () => {
    if (buffer.length === 0) return

    chunks.push({ kind: input.kind, text: buffer.join('\n') })
    buffer = []
    chars = 0
  }

  for (const line of lines) {
    // 单行本身就超预算时独占一片：硬切会把一个单词劈成两半
    if (buffer.length > 0 && chars + line.length > config.importAiMaxCharsPerCall) flush()

    buffer.push(line)
    chars += line.length + 1

    if (buffer.length >= config.importAiMaxRowsPerCall) flush()
  }

  flush()

  return chunks
}

export function assertUserQuota(userId) {
  const now = Date.now()
  const limit = config.importAiUserLimit

  // 顺手清理过期桶，避免长期运行时 Map 只增不减
  if (quotaBuckets.size > 5_000) {
    for (const [key, bucket] of quotaBuckets) {
      if (bucket.resetAt <= now) quotaBuckets.delete(key)
    }
  }

  const bucket = quotaBuckets.get(userId)

  if (!bucket || bucket.resetAt <= now) {
    quotaBuckets.set(userId, { count: 1, resetAt: now + QUOTA_WINDOW_MS })
    return
  }

  if (bucket.count >= limit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)

    throw new ApiError(
      429,
      ERROR_CODES.RATE_LIMITED,
      `AI 识别太频繁：每小时最多 ${limit} 次，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`,
      '',
      { limit, windowSeconds: 3600, retryAfter },
    )
  }

  bucket.count += 1
}
