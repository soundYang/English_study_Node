import OpenAI from 'openai'

import { config } from '../../config/index.js'
import { ApiError, ERROR_CODES } from '../../shared/errors.js'

let client = null

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

    return {
      content: response.choices[0]?.message?.content ?? '',
      usage: response.usage ?? null,
    }
  } catch (err) {
    // 客户端主动取消：不映射成 502，原样抛出，由路由判断"已断开"后静默结束
    if (signal?.aborted || err?.name === 'AbortError') throw err

    throw new ApiError(
      502,
      ERROR_CODES.AI_PROVIDER_ERROR,
      'AI 服务暂时不可用，请稍后重试。',
    )
  }
}
