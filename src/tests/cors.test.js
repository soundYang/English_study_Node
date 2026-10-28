import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * CORS 白名单（局域网联调）。
 *
 * 单源配置的坑：本机用 localhost、手机用 192.168.x.x，是两个不同的 Origin，
 * 换成局域网地址就会把本机拦掉。这里验证逗号分隔多源、结尾斜杠归一化，
 * 以及「不在名单里」时正确行为是**不返回 CORS 头**，而不是 500。
 *
 * 故意在值里带一个结尾斜杠与空格：真实 .env 里经常这么写。
 */
process.env.CLIENT_ORIGIN = 'http://localhost:5173/, http://192.0.2.16:5173'

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')

const app = createApp()

const allowOrigin = (res) => res.headers['access-control-allow-origin']

describe('CLIENT_ORIGIN 多源', () => {
  it('解析时去掉空格与结尾斜杠', () => {
    expect(config.clientOrigins).toEqual(['http://localhost:5173', 'http://192.0.2.16:5173'])
  })

  it('本机来源放行', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173')

    expect(res.status).toBe(200)
    expect(allowOrigin(res)).toBe('http://localhost:5173')
  })

  it('局域网来源放行', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://192.0.2.16:5173')

    expect(res.status).toBe(200)
    expect(allowOrigin(res)).toBe('http://192.0.2.16:5173')
  })

  it('不在名单里的来源：请求照常处理，但不回 CORS 头（不是 500）', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://evil.example.com')

    expect(res.status).toBe(200)
    expect(allowOrigin(res)).toBeUndefined()
  })

  it('没有 Origin 的请求（curl / 服务端）直接放行', async () => {
    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    // 没有 Origin 时 cors 不会加这个头，放行的证据是请求本身正常返回
    expect(allowOrigin(res)).toBeUndefined()
  })

  it('预检被拦下时同样不回 CORS 头', async () => {
    const res = await request(app)
      .options('/api/readings/generate')
      .set('Origin', 'http://evil.example.com')
      .set('Access-Control-Request-Method', 'POST')

    expect(allowOrigin(res)).toBeUndefined()
  })

  it('预检通过时回显来源与允许的方法', async () => {
    const res = await request(app)
      .options('/api/readings/generate')
      .set('Origin', 'http://192.0.2.16:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-device-id,authorization,content-type')

    expect(res.status).toBeLessThan(300)
    expect(allowOrigin(res)).toBe('http://192.0.2.16:5173')
    // X-Device-Id 是前端统一注入的自定义头，预检必须放行它
    expect(res.headers['access-control-allow-headers']).toMatch(/x-device-id/i)
  })
})
