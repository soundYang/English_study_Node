/**
 * PII 脱敏（md/45 M6）。
 *
 * 管理端列表一次返回一页 20 条，手机号与联系方式都在里面。完整值只给
 * 「详情」这种有审计点的接口，列表统一打码——否则一次翻页就能批量导出，
 * 而且不留任何痕迹。
 */

/** `13800000000` → `138****0000`；空值保持 null，前端显示「未填写」 */
export function maskPhone(phone) {
  if (!phone) return null

  const value = String(phone)

  // 短号不脱敏会变成满屏星号，反而看不出是号码
  if (value.length <= 7) return value

  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

/**
 * 联系方式是自由文本（微信号 / QQ / 邮箱 / 手机号），没法按定长裁剪：
 *   · 带 `@` 的按邮箱处理，只留前 2 个字符 + 域名；
 *   · 其余保留头尾，够长才留 3 + 4，否则 2 + 2；
 *   · 比「头 + 尾」还短的直接全遮。
 *
 * 目标不是「不可逆」，而是列表页扫一眼看不出完整值——真正的防泄露靠
 * 列表不返回完整值，而不是靠这行星号。
 */
export function maskContact(contact) {
  const text = String(contact ?? '').trim()
  if (!text) return ''

  const at = text.indexOf('@')
  if (at > 0) {
    const local = text.slice(0, at)
    return `${local.slice(0, Math.min(2, local.length))}***${text.slice(at)}`
  }

  const long = text.length >= 11
  const head = long ? 3 : 2
  const tail = long ? 4 : 2

  if (text.length <= head + tail) return '***'

  return `${text.slice(0, head)}****${text.slice(-tail)}`
}
