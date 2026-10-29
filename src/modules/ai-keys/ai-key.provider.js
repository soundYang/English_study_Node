import { config } from '../../config/index.js'
import { userApiKeyInvalid, userApiKeyVerifyFailed } from '../../shared/errors.js'

/**
 * 上游校验（md/43 §5.2）。
 *
 * 只请求 `GET /models`：它不产生 token 费用，也不受 JSON 模式影响。
 * **不要**用一次 chat 调用来验证——那会让「导入 Key」变成一次真实计费。
 *
 * 错误映射：
 *   401 / 403 → USER_API_KEY_INVALID（Key 本身的问题，让用户改）
 *   其它 / 超时 / 网络 → USER_API_KEY_VERIFY_FAILED（我们暂时判断不了，让他重试）
 *
 * 这里**不记 Key**：异常信息里只有状态码。
 */
export async function verifyDeepSeekKey(apiKey, { timeoutMs = config.userApiKeyVerifyTimeoutMs } = {}) {
  const base = config.deepseekBaseUrl.replace(/\/+$/, '')
  let response

  try {
    response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw userApiKeyVerifyFailed()
  }

  if (response.ok) return true
  if (response.status === 401 || response.status === 403) throw userApiKeyInvalid()

  throw userApiKeyVerifyFailed()
}
