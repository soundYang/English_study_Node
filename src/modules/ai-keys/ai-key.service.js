import { config } from '../../config/index.js'
import {
  ERROR_CODES,
  userApiKeyDisabled,
  userApiKeyMissing,
} from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { decryptSecret, encryptSecret, fingerprintKey } from './ai-key.crypto.js'
import { UserApiKey } from './ai-key.model.js'
import { verifyDeepSeekKey } from './ai-key.provider.js'
import { saveApiKeySchema } from './ai-key.schema.js'

/**
 * 自备 API Key 的服务层（md/43）。
 *
 * 一条原则：**Key 只在「加密入参」和「解密出参」这两瞬间以明文存在**。
 * 除此之外的返回值、日志、DTO 里都只有掩码或指纹。
 */

const PROVIDER = 'deepseek'

/** 功能是否可用：开关打开且配了主密钥。GET 用它与生成侧判定同一口径 */
export function isUserApiKeyEnabled() {
  return config.userApiKeyEnabled && Boolean(config.userApiKeySecret)
}

/** 免费路径的 Key 描述。生成链路的默认值，也是「没有自备 Key」的唯一表示 */
export function freeAiKey() {
  return {
    source: 'free',
    apiKey: config.deepseekApiKey,
    provider: PROVIDER,
    keyId: null,
  }
}

function assertEnabled() {
  if (!isUserApiKeyEnabled()) throw userApiKeyDisabled()
}

function toKeyDto(doc, { readable = true } = {}) {
  return {
    provider: doc.provider,
    maskedKey: `sk-****${doc.last4}`,
    status: readable ? doc.status : 'unreadable',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastVerifiedAt: doc.lastVerifiedAt ?? null,
    lastUsedAt: doc.lastUsedAt ?? null,
  }
}

/**
 * 生成开始前解析一次（md/43 §6.1）。
 *
 * 解密失败按「没有自备 Key」处理：这时每日额度与免费池闸门都会照常生效，
 * 不会出现「以为在用自备 Key，实际在花免费池」的账。
 */
export async function resolveAiKey(userId) {
  if (!isUserApiKeyEnabled() || !userId) return freeAiKey()

  const doc = await UserApiKey.findOne({ userId, provider: PROVIDER }).lean()
  if (!doc) return freeAiKey()

  try {
    const apiKey = decryptSecret(doc.cipher)

    // 一次生成只解析一次，这里顺手记最近使用时间；失败不影响生成
    void UserApiKey.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch(
      (error) => {
        logger.warn({ err: error, userId }, 'user api key touch failed')
      },
    )

    return { source: 'user', apiKey, provider: doc.provider, keyId: String(doc._id) }
  } catch (error) {
    // 只记 message：cipher / 明文 / secret 都不进日志
    logger.error(
      { err: { message: error?.message }, userId, provider: doc.provider },
      'user api key decrypt failed',
    )
    return freeAiKey()
  }
}

/** GET /api/profile/api-key */
export async function getApiKeyView({ userId }) {
  const enabled = isUserApiKeyEnabled()
  const base = { enabled, supportedProviders: [PROVIDER] }

  if (!enabled) return { ...base, key: null }

  const doc = await UserApiKey.findOne({ userId, provider: PROVIDER }).lean()
  if (!doc) return { ...base, key: null }

  let readable = true
  try {
    decryptSecret(doc.cipher)
  } catch {
    readable = false
  }

  return { ...base, key: toKeyDto(doc, { readable }) }
}

/**
 * PUT /api/profile/api-key。
 *
 * 顺序固定：格式 → 上游校验 → 加密 → upsert。
 * 校验失败**不改动**已有 Key：替换失败等于原样保留，用户不会因为一次手滑失去旧 Key。
 */
export async function saveApiKey({ userId, body }) {
  assertEnabled()

  const input = parseOrThrow(saveApiKeySchema, body)
  await verifyDeepSeekKey(input.apiKey)

  const now = new Date()
  const patch = {
    cipher: encryptSecret(input.apiKey),
    last4: input.apiKey.slice(-4),
    fingerprint: fingerprintKey(input.apiKey),
    status: 'active',
    lastVerifiedAt: now,
  }

  // 并发 upsert 同一条时，后插入的会撞 { userId, provider } 唯一索引；
  // 重试一次就会走 update 分支（与 budget.service.js 同一处理）
  for (let attempt = 1; ; attempt += 1) {
    try {
      await UserApiKey.findOneAndUpdate(
        { userId, provider: input.provider },
        { $set: patch, $setOnInsert: { userId, provider: input.provider } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      break
    } catch (error) {
      if (error?.code !== 11000 || attempt >= 2) throw error
    }
  }

  return getApiKeyView({ userId })
}

/** DELETE /api/profile/api-key：幂等，不存在的 Key 也返回成功 */
export async function removeApiKey({ userId }) {
  // 功能关闭时写操作一律 503（md/43 §9）：前端已经把整块隐藏，走到这里只可能是旧页面
  assertEnabled()

  await UserApiKey.deleteOne({ userId, provider: PROVIDER })

  return { ok: true, enabled: isUserApiKeyEnabled(), key: null }
}

/**
 * POST /api/profile/api-key/verify。
 *
 * 只有「上游明确拒绝」才把状态改成 invalid；网络失败保持原状态，
 * 否则一次上游抖动就会让所有人的 Key 看起来都坏了。
 */
export async function verifyStoredApiKey({ userId }) {
  assertEnabled()

  const doc = await UserApiKey.findOne({ userId, provider: PROVIDER })
  if (!doc) throw userApiKeyMissing()

  let apiKey
  try {
    apiKey = decryptSecret(doc.cipher)
  } catch (error) {
    logger.error(
      { err: { message: error?.message }, userId, provider: doc.provider },
      'user api key decrypt failed',
    )
    throw userApiKeyMissing()
  }

  try {
    await verifyDeepSeekKey(apiKey)
  } catch (error) {
    if (error?.code === ERROR_CODES.USER_API_KEY_INVALID) {
      await UserApiKey.updateOne({ _id: doc._id }, { $set: { status: 'invalid' } }).catch(
        (updateError) => {
          logger.warn({ err: updateError, userId }, 'user api key status write failed')
        },
      )
    }
    throw error
  }

  await UserApiKey.updateOne(
    { _id: doc._id },
    { $set: { status: 'active', lastVerifiedAt: new Date() } },
  )

  return getApiKeyView({ userId })
}

/**
 * 生成时上游 401/403：把这条 Key 标成 invalid。
 * fire-and-forget，写库失败只记日志——不能因为状态写不进去把生成错误换掉。
 */
export async function markUserApiKeyInvalid(keyId) {
  if (!keyId) return

  try {
    await UserApiKey.updateOne({ _id: keyId }, { $set: { status: 'invalid' } })
  } catch (error) {
    logger.warn({ err: error, keyId }, 'user api key status write failed')
  }
}
