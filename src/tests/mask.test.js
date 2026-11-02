import { describe, expect, it } from 'vitest'

import { maskContact, maskPhone } from '../shared/utils/mask.js'

/**
 * PII 脱敏（md/45 M6）。
 *
 * 这里的断言只保证「列表里看不出完整值」，不追求不可逆——
 * 真正的保护是列表根本不返回完整字段。
 */
describe('maskPhone', () => {
  it('空值保持 null，前端显示「未填写」', () => {
    expect(maskPhone(null)).toBeNull()
    expect(maskPhone('')).toBeNull()
  })

  it('正常手机号保留前 3 后 4', () => {
    expect(maskPhone('13800000000')).toBe('138****0000')
  })

  it('短号原样返回，避免变成满屏星号', () => {
    expect(maskPhone('1234567')).toBe('1234567')
  })
})

describe('maskContact', () => {
  it('空值返回空串', () => {
    expect(maskContact('')).toBe('')
    expect(maskContact(null)).toBe('')
  })

  it('手机号形状与 maskPhone 一致', () => {
    expect(maskContact('13800000000')).toBe('138****0000')
  })

  it('邮箱只留前 2 个字符 + 域名', () => {
    expect(maskContact('someone@example.com')).toBe('so***@example.com')
  })

  it('自由文本（微信号 / QQ）保留头尾', () => {
    expect(maskContact('wxid_abcdefg')).toBe('wxi****defg')
  })

  it('比头尾之和还短的直接全遮', () => {
    expect(maskContact('abc')).toBe('***')
  })
})
