import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

import { config } from '../../config/index.js'

/**
 * 自备 API Key 的加解密（md/43 §4）。
 *
 * 只做三件事：把 env 里的 secret 派生成 AES key、用 AES-256-GCM 加密、
 * 把结果装进可轮换的信封。**不做任何 IO**，便于单测。
 *
 * 信封：v1.<kid>.<iv>.<tag>.<ciphertext>
 *   kid        = sha256(secret) 前 8 位，解密时据此挑当前 / 上一把 secret
 *   iv / tag   = 12 / 16 字节，base64url
 *   每次加密都生成新 IV；复用 IV 会让 GCM 直接失去安全保证
 */

const VERSION = 'v1'
const SALT = 'wr.user-api-key'
const INFO = 'v1'
const IV_BYTES = 12
const KEY_BYTES = 32

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url')
}

/** 只用 secret 的哈希做标识：日志 / 信封里都不出现 secret 本身 */
function secretId(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8)
}

function deriveKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, INFO, KEY_BYTES))
}

/** 服务端是否具备加解密条件（与 config.userApiKeyEnabled 一起构成有效开关） */
export function hasCryptoSecret() {
  return Boolean(config.userApiKeySecret)
}

export function encryptSecret(plaintext) {
  if (!config.userApiKeySecret) throw new Error('USER_API_KEY_SECRET 未配置')

  const key = deriveKey(config.userApiKeySecret)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    VERSION,
    secretId(config.userApiKeySecret),
    toBase64Url(iv),
    toBase64Url(tag),
    toBase64Url(ciphertext),
  ].join('.')
}

/**
 * 解密。任何结构 / 认证失败都抛普通 Error——调用方按 md/43 §4.4 处理
 * （生成侧回落免费路径，接口侧标 unreadable），不要把细节透给前端。
 */
export function decryptSecret(payload) {
  const parts = String(payload ?? '').split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('unsupported cipher envelope')
  }

  const [, kid, iv, tag, ciphertext] = parts
  // 当前 secret 优先；轮换期间上一把仍要能解开
  const candidates = [config.userApiKeySecret, config.userApiKeySecretPrevious].filter(Boolean)
  const secret = candidates.find((item) => secretId(item) === kid)
  if (!secret) throw new Error('no secret matches key id')

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), fromBase64Url(iv))
  decipher.setAuthTag(fromBase64Url(tag))

  return Buffer.concat([decipher.update(fromBase64Url(ciphertext)), decipher.final()]).toString('utf8')
}

/** 只保留 sk- 与后 4 位；接口响应里唯一允许出现的 Key 形态 */
export function maskKey(apiKey) {
  return `sk-****${String(apiKey).slice(-4)}`
}

/** 不可逆指纹：排查「是不是同一把 Key」时用，绝不能当密文用 */
export function fingerprintKey(apiKey) {
  return createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16)
}
