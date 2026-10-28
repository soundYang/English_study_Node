import { describe, expect, it } from 'vitest'

import { CHARSET, randomText, renderSvg } from '../modules/auth/captcha.js'
import { Captcha } from '../modules/auth/captcha.model.js'
import {
  CAPTCHA_TTL_SECONDS,
  createCaptcha,
  verifyCaptcha,
} from '../modules/auth/captcha.service.js'

/**
 * 图形验证码（md/33 §5 / S2）。
 *
 * 这里最要紧的两条不是「能不能校验通过」，而是：
 *   1. SVG 里**不能出现可读的答案**——否则整个验证码等于没有；
 *   2. 校验必须**一次性**——同一张图用第二次必须失败。
 */

describe('randomText', () => {
  it('默认 4 位，且每一位都在字符集里', () => {
    for (let i = 0; i < 50; i += 1) {
      const text = randomText()
      expect(text).toHaveLength(4)
      for (const char of text) expect(CHARSET).toContain(char)
    }
  })

  it('字符集不含形近字 I / O / 0 / 1', () => {
    for (const char of 'IO01') expect(CHARSET).not.toContain(char)
  })

  it('确实在随机，不是固定串', () => {
    const seen = new Set()
    for (let i = 0; i < 2000; i += 1) for (const char of randomText()) seen.add(char)

    // 32 个字符都可能出现；2000 次里覆盖不到 20 个就说明随机源有问题
    expect(seen.size).toBeGreaterThan(20)
    expect(seen.size).toBeLessThanOrEqual(CHARSET.length)
  })
})

describe('renderSvg', () => {
  it('是一张完整的 SVG', () => {
    const svg = renderSvg('AB3D')

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('viewBox="0 0 120 40"')
    expect(svg).toContain('<path')
  })

  it('不包含 <text>，字符一律画成 path', () => {
    // 这是整份实现的红线：SVG 直接以字符串回给前端，
    // 用 <text> 等于把答案原样交出去，正则一抓就有
    for (const text of ['AB3D', 'WXYZ', '2345', 'MNQP']) {
      expect(renderSvg(text)).not.toContain('<text')
    }
  })

  it('答案字符串不会出现在 SVG 里', () => {
    for (const text of ['AB3D', 'WXYZ', '2345', 'MNQP', 'HJKL']) {
      expect(renderSvg(text).toUpperCase()).not.toContain(text)
    }
  })

  it('字号变化后仍然不含可读文字（长度不只是 4 位）', () => {
    expect(renderSvg('ABCDEF')).not.toContain('<text')
  })
})

describe('createCaptcha', () => {
  it('返回 captchaId / svg / expiresIn', async () => {
    const result = await createCaptcha({ ip: '127.0.0.1' })

    expect(result.captchaId).toMatch(/^[0-9a-f]{24}$/)
    expect(result.svg).toContain('<svg')
    expect(result.expiresIn).toBe(CAPTCHA_TTL_SECONDS)
  })

  it('库里只存答案哈希，没有明文答案', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })
    const doc = await Captcha.findById(captchaId).lean()

    expect(doc.answerHash).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.answerHash).not.toContain('ab3d')
    // 连字段都不该存在：多一个 answer 字段就等于把验证码写在库里
    expect(doc.answer).toBeUndefined()
  })

  it('过期时间约 5 分钟后', async () => {
    const { captchaId } = await createCaptcha()
    const doc = await Captcha.findById(captchaId).lean()

    const remainingSeconds = (doc.expiresAt.getTime() - Date.now()) / 1000
    expect(remainingSeconds).toBeGreaterThan(CAPTCHA_TTL_SECONDS - 5)
    expect(remainingSeconds).toBeLessThanOrEqual(CAPTCHA_TTL_SECONDS)
  })
})

describe('verifyCaptcha', () => {
  it('答对了返回 true', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })

    await expect(verifyCaptcha({ captchaId, answer: 'AB3D' })).resolves.toBe(true)
  })

  it('大小写与首尾空格不影响结果', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })

    await expect(verifyCaptcha({ captchaId, answer: '  ab3d  ' })).resolves.toBe(true)
  })

  it('同一张图只能用一次', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })

    await expect(verifyCaptcha({ captchaId, answer: 'AB3D' })).resolves.toBe(true)
    // 第二次：文档已经被 findOneAndDelete 拿走，等价于「过期或用过」
    await expect(verifyCaptcha({ captchaId, answer: 'AB3D' })).rejects.toMatchObject({
      code: 'CAPTCHA_EXPIRED',
      status: 400,
    })
  })

  it('答错了抛 CAPTCHA_INVALID，并且这张图同样作废', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })

    await expect(verifyCaptcha({ captchaId, answer: 'AB3E' })).rejects.toMatchObject({
      code: 'CAPTCHA_INVALID',
      status: 400,
      field: 'captchaCode',
    })

    // 输错一次就消耗掉了：想再试必须换图，否则一个 id 可以猜 32^4 次
    const doc = await Captcha.findById(captchaId).lean()
    expect(doc).toBeNull()
    await expect(verifyCaptcha({ captchaId, answer: 'AB3D' })).rejects.toMatchObject({
      code: 'CAPTCHA_EXPIRED',
    })
  })

  it('过期的验证码抛 CAPTCHA_EXPIRED', async () => {
    const { captchaId } = await createCaptcha({ text: 'AB3D' })
    await Captcha.updateOne({ _id: captchaId }, { $set: { expiresAt: new Date(Date.now() - 1000) } })

    await expect(verifyCaptcha({ captchaId, answer: 'AB3D' })).rejects.toMatchObject({
      code: 'CAPTCHA_EXPIRED',
    })
  })

  it('畸形 id 与不存在的 id 都按过期处理，不会 500', async () => {
    await expect(verifyCaptcha({ captchaId: 'not-an-id', answer: 'AB3D' })).rejects.toMatchObject({
      code: 'CAPTCHA_EXPIRED',
    })
    await expect(
      verifyCaptcha({ captchaId: '65f000000000000000000000', answer: 'AB3D' }),
    ).rejects.toMatchObject({ code: 'CAPTCHA_EXPIRED' })
  })
})
