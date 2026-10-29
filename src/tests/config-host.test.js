import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * HOST 配置（md/45 L9）。
 *
 * 这条配置决定了「端口绑在哪个网卡上」，写错的后果是两种极端：
 * 生产写了 `0.0.0.0`（或不写）→ 3000 直接对公网监听，只剩安全组一层；
 * 本地开发误写成 `127.0.0.1` → 手机/另一台电脑连不上调试端口。
 * 所以这里把「留空 = 不传 host」这条边界钉死。
 */

const originalHost = process.env.HOST

async function loadConfigWith(host) {
  vi.resetModules()
  if (host === undefined) delete process.env.HOST
  else process.env.HOST = host

  const { config } = await import('../config/index.js')
  return config
}

describe('config.host', () => {
  afterEach(() => {
    if (originalHost === undefined) delete process.env.HOST
    else process.env.HOST = originalHost
    vi.resetModules()
  })

  it('不配置时是 undefined，交给 Node 用默认的「所有网卡」', async () => {
    const config = await loadConfigWith(undefined)

    // 传空串或 '0.0.0.0' 都会让 app.listen(port, host) 的行为依赖 Node 版本，
    // undefined 才是「不提这个参数」
    expect(config.host).toBeUndefined()
  })

  it('配置后原样保留，并去掉首尾空格', async () => {
    expect((await loadConfigWith('127.0.0.1')).host).toBe('127.0.0.1')

    const padded = await loadConfigWith('  127.0.0.1  ')
    expect(padded.host).toBe('127.0.0.1')
  })

  it('只写空白等价于没写', async () => {
    const config = await loadConfigWith('   ')

    expect(config.host).toBeUndefined()
  })
})
