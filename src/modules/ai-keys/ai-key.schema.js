import { z } from 'zod'

/**
 * 导入 Key 的请求体（md/43 §5.2）。
 *
 * 格式校验只在这里做一次：再往下就只剩「加密」和「调上游校验」，
 * 任何一层都不要把用户输入原样拼进错误信息。
 */
export const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,120}$/

export const saveApiKeySchema = z.object({
  // v1 只有 deepseek；显式传别的厂商直接 400，而不是静默降级
  provider: z.enum(['deepseek'], { error: '目前只支持 deepseek' }).default('deepseek'),
  apiKey: z
    .string({ error: '请输入 API Key' })
    .trim()
    .min(20, 'API Key 长度不正确')
    .max(128, 'API Key 太长')
    .regex(API_KEY_PATTERN, 'API Key 格式不正确，应以 sk- 开头'),
})
