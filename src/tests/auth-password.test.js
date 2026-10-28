import { randomBytes, scryptSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  getDummyHash,
  hashPassword,
  needsRehash,
  SCRYPT_PARAMS,
  verifyPassword,
} from '../modules/auth/password.js'

/**
 * scrypt 封装（md/33 §4.1 / S1）。
 *
 * 这里不测「密码强度」——那是注册表单的 zod 规则，在 S3 的 auth.schema.js 里。
 * 本文件只关心一件事：**存进去的字符串能不能把原密码校验回来，脏数据会不会 500**。
 */

describe('hashPassword / verifyPassword', () => {
  it('同一个密码两次哈希不同（每次新盐），但都能校验通过', async () => {
    const first = await hashPassword('Passw0rd!')
    const second = await hashPassword('Passw0rd!')

    expect(first).not.toBe(second)
    await expect(verifyPassword('Passw0rd!', first)).resolves.toBe(true)
    await expect(verifyPassword('Passw0rd!', second)).resolves.toBe(true)
  })

  it('密码错一个字符就不通过', async () => {
    const stored = await hashPassword('Passw0rd!')

    await expect(verifyPassword('Passw0rd', stored)).resolves.toBe(false)
    await expect(verifyPassword('passw0rd!', stored)).resolves.toBe(false)
  })

  it('存储串是自描述格式，六个字段都在', async () => {
    const [prefix, N, r, p, salt, hash] = (await hashPassword('Passw0rd!')).split('$')

    expect(prefix).toBe('scrypt')
    expect(Number(N)).toBe(SCRYPT_PARAMS.N)
    expect(Number(r)).toBe(SCRYPT_PARAMS.r)
    expect(Number(p)).toBe(SCRYPT_PARAMS.p)
    expect(Buffer.from(salt, 'base64')).toHaveLength(SCRYPT_PARAMS.saltBytes)
    expect(Buffer.from(hash, 'base64')).toHaveLength(SCRYPT_PARAMS.keylen)
  })

  it('按存储串里的参数校验，老参数的哈希仍然有效', async () => {
    // 模拟「以前用 N=1024 存下的密码」：参数换了之后老用户不该被锁在门外
    const salt = randomBytes(16)
    const derived = scryptSync('Passw0rd!', salt, 32, { N: 1024, r: 8, p: 1 })
    const legacy = `scrypt$1024$8$1$${salt.toString('base64')}$${derived.toString('base64')}`

    await expect(verifyPassword('Passw0rd!', legacy)).resolves.toBe(true)
    expect(needsRehash(legacy)).toBe(true)
  })
})

describe('脏数据不抛异常', () => {
  const malformed = [
    ['空串', ''],
    ['不是自己的格式', '$2b$10$abcdefghijklmnopqrstuv'],
    ['字段数不对', 'scrypt$16384$8$1$abc'],
    ['N 不是 2 的幂', 'scrypt$12345$8$1$YWJj$YWJj'],
    // 一个能拖垮进程的 N：必须在浪费内存之前拒绝
    ['N 超过上限', `scrypt$${1 << 21}$8$1$YWJj$YWJj`],
    ['r 为 0', 'scrypt$16384$0$1$YWJj$YWJj'],
    ['盐或哈希为空', 'scrypt$16384$8$1$$'],
  ]

  for (const [name, stored] of malformed) {
    it(`${name} → false，不抛`, async () => {
      await expect(verifyPassword('Passw0rd!', stored)).resolves.toBe(false)
    })
  }

  it('stored 为 null / undefined / 非字符串', async () => {
    await expect(verifyPassword('Passw0rd!', null)).resolves.toBe(false)
    await expect(verifyPassword('Passw0rd!', undefined)).resolves.toBe(false)
    await expect(verifyPassword('Passw0rd!', 123)).resolves.toBe(false)
  })

  it('密码传空串直接 false，不会「空密码匹配空密码」', async () => {
    const stored = await hashPassword('Passw0rd!')
    await expect(verifyPassword('', stored)).resolves.toBe(false)
  })
})

describe('hashPassword 的入参', () => {
  it('空密码是调用方的 bug，必须显式抛错', async () => {
    await expect(hashPassword('')).rejects.toThrow(TypeError)
    await expect(hashPassword(null)).rejects.toThrow(TypeError)
  })
})

describe('needsRehash', () => {
  it('当前参数不需要重算', async () => {
    expect(needsRehash(await hashPassword('Passw0rd!'))).toBe(false)
  })

  it('解析不了的串视为需要重算', () => {
    expect(needsRehash('')).toBe(true)
    expect(needsRehash(null)).toBe(true)
  })
})

describe('getDummyHash', () => {
  it('返回一个格式合法的哈希，且任何密码都校验不过', async () => {
    const dummy = await getDummyHash()

    expect(dummy.startsWith('scrypt$')).toBe(true)
    await expect(verifyPassword('Passw0rd!', dummy)).resolves.toBe(false)
    await expect(verifyPassword('', dummy)).resolves.toBe(false)
  })

  it('多次调用只生成一次', async () => {
    const [a, b] = await Promise.all([getDummyHash(), getDummyHash()])
    expect(a).toBe(b)
  })
})
