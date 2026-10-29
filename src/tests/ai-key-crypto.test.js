import { randomBytes } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

/**
 * 自备 Key 的加解密（md/43 §4 / §11.1）。
 *
 * `config` 是冻结对象，不能就地改主密钥，所以每个用例都用 `vi.resetModules()`
 * 重新加载一次 config + crypto：与「重启服务换 Secret」是同一条路径。
 * 这里不碰数据库、不碰网络。
 */

const SECRET = randomBytes(32).toString('base64')
const PREVIOUS = randomBytes(32).toString('base64')
const OTHER = randomBytes(32).toString('base64')

const PLAINTEXT = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/unused'

async function load({ secret = SECRET, previous = '', enabled = 'true' } = {}) {
  process.env.USER_API_KEY_ENABLED = enabled
  process.env.USER_API_KEY_SECRET = secret
  process.env.USER_API_KEY_SECRET_PREVIOUS = previous

  vi.resetModules()
  const crypto = await import('../modules/ai-keys/ai-key.crypto.js')

  return crypto
}

describe('加解密往返', () => {
  it('明文完全一致', async () => {
    const { encryptSecret, decryptSecret } = await load()

    expect(decryptSecret(encryptSecret(PLAINTEXT))).toBe(PLAINTEXT)
  })

  it('同一明文加密两次，密文不同但都能解开（IV 随机）', async () => {
    const { encryptSecret, decryptSecret } = await load()

    const first = encryptSecret(PLAINTEXT)
    const second = encryptSecret(PLAINTEXT)

    expect(first).not.toBe(second)
    expect(decryptSecret(first)).toBe(PLAINTEXT)
    expect(decryptSecret(second)).toBe(PLAINTEXT)
  })

  it('信封格式：v1.<8hex>.<iv>.<tag>.<ct>，各段 base64url 可解析', async () => {
    const { encryptSecret } = await load()
    const parts = encryptSecret(PLAINTEXT).split('.')

    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe('v1')
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/)
    // 12 字节 IV / 16 字节 tag
    expect(Buffer.from(parts[2], 'base64url')).toHaveLength(12)
    expect(Buffer.from(parts[3], 'base64url')).toHaveLength(16)
    expect(Buffer.from(parts[4], 'base64url').toString('utf8')).not.toBe(PLAINTEXT)
  })
})

describe('篡改与密钥不匹配', () => {
  it.each([
    ['iv', 2],
    ['tag', 3],
    ['ciphertext', 4],
  ])('篡改 %s → 抛错，不会返回半截明文', async (label, index) => {
    const { encryptSecret, decryptSecret } = await load()
    const parts = encryptSecret(PLAINTEXT).split('.')
    const bytes = Buffer.from(parts[index], 'base64url')
    bytes[0] ^= 0xff
    parts[index] = bytes.toString('base64url')

    expect(() => decryptSecret(parts.join('.'))).toThrow()
  })

  it('结构与版本不对 → 抛错', async () => {
    const { decryptSecret } = await load()

    expect(() => decryptSecret('')).toThrow()
    expect(() => decryptSecret('v2.a.b.c.d')).toThrow()
    expect(() => decryptSecret('v1.only-one-part')).toThrow()
  })

  it('kid 指向 PREVIOUS 时仍能解开（轮换场景）', async () => {
    const old = await load({ secret: SECRET })
    const payload = old.encryptSecret(PLAINTEXT)

    // 换新主密钥，旧值留在 _PREVIOUS
    const rotated = await load({ secret: OTHER, previous: SECRET })

    expect(rotated.decryptSecret(payload)).toBe(PLAINTEXT)
  })

  it('两把密钥都不匹配 → 抛错（调用方按 md/43 §4.4 回落免费）', async () => {
    const old = await load({ secret: SECRET })
    const payload = old.encryptSecret(PLAINTEXT)

    const broken = await load({ secret: OTHER, previous: PREVIOUS })

    expect(() => broken.decryptSecret(payload)).toThrow(/no secret matches/)
  })
})

describe('掩码与指纹', () => {
  it('掩码只保留 sk- 与后 4 位', async () => {
    const { maskKey } = await load()

    expect(maskKey(PLAINTEXT)).toBe('sk-****6789')
    expect(maskKey('sk-1234')).toBe('sk-****1234')
  })

  it('指纹是 16 位 sha256 片段，同 Key 同值、不同 Key 不同值', async () => {
    const { fingerprintKey } = await load()

    expect(fingerprintKey(PLAINTEXT)).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprintKey(PLAINTEXT)).toBe(fingerprintKey(PLAINTEXT))
    expect(fingerprintKey(PLAINTEXT)).not.toBe(fingerprintKey(`${PLAINTEXT}x`))
  })

  it('没有配置 secret 时 hasCryptoSecret 为 false 且加密抛错', async () => {
    const { hasCryptoSecret, encryptSecret } = await load({ secret: '' })

    expect(hasCryptoSecret()).toBe(false)
    expect(() => encryptSecret(PLAINTEXT)).toThrow(/未配置/)
  })
})
