import OpenAI from 'openai'

import { config } from '../../config/index.js'
import { ApiError, ERROR_CODES } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'

let client = null

/** 上游报错只留诊断信息，且把可能出现的 key 片段抹掉 */
function describeUpstreamError(err) {
  const message = String(err?.error?.message ?? err?.message ?? '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 300)

  return {
    name: err?.name,
    status: err?.status,
    code: err?.code ?? err?.error?.code,
    type: err?.error?.type,
    message,
  }
}

/**
 * 只重试「根本没拿到响应」的情况：超时、连接被重置。
 * 4xx 是我们请求写错了，重试没用；5xx 由用户或下一个修正轮兜底。
 */
function isRetryable(err) {
  if (err?.name === 'APIConnectionTimeoutError' || err?.name === 'APIConnectionError') return true
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET') return true

  return /timed out|timeout|socket hang up/i.test(String(err?.message ?? ''))
}

/** 懒初始化：没有 key 的测试环境不会在这里就抛错 */
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.deepseekApiKey || 'missing-api-key',
      baseURL: config.deepseekBaseUrl,
      timeout: config.deepseekTimeoutMs,
      // 重试由我们自己的修正轮控制，叠加 SDK 重试会把调用次数放大到不可控
      maxRetries: 0,
    })
  }

  return client
}

/**
 * 调一次上游，返回原始文本与用量。
 *
 * 错误映射：超时 / 429 / 5xx / 连接失败一律转 502 AI_PROVIDER_ERROR，
 * message 用固定文案——**绝不把上游原始报错透给前端**（可能含 key 片段或内部信息）。
 */
export async function chatJson({ messages, signal, maxTokens }) {
  // 偶发超时重试一次：实测出现过 10 秒就 Request timed out、整次生成直接 502。
  // 只重试一次——连续两次拿不到响应说明上游确实不可用，把额度留给用户重试。
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await getClient().chat.completions.create(
        {
          model: config.deepseekModel,
          messages,
          // DeepSeek 的 JSON 模式要求提示词里出现 "json" 字样，系统提示词已满足
          response_format: { type: 'json_object' },
          temperature: 0.8,
          max_tokens: maxTokens,
        },
        { signal },
      )

      const choice = response.choices[0]

      // 截断时 finish_reason = 'length'，正文末尾会缺一大截，调用方要能看见
      return {
        content: choice?.message?.content ?? '',
        usage: response.usage ?? null,
        finishReason: choice?.finish_reason ?? null,
      }
    } catch (err) {
      // 客户端主动取消：不映射成 502，原样抛出，由路由判断"已断开"后静默结束
      if (signal?.aborted || err?.name === 'AbortError') throw err

      logger.warn({ err: describeUpstreamError(err), attempt }, 'deepseek request failed')

      if (attempt === 1 && isRetryable(err)) continue

      throw new ApiError(
        502,
        ERROR_CODES.AI_PROVIDER_ERROR,
        'AI 服务暂时不可用，请稍后重试。',
      )
    }
  }
}
