import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 写接口限流（md/45 M5）。
 *
 * 限流计的是**请求次数**，不看响应码，所以这里可以全用非法请求：
 * 校验在第一行就拒掉，既不写库也不碰模型，20 次跑完不到一秒。
 *
 * 全局兜底在这个文件里保持默认（300/分钟）不会被撞到；
 * 它自己的行为由 rate-limit-global.test.js 单独验证。
 */
process.env.RATE_LIMIT_ENABLED = 'true'

const { createApp } = await import('../app.js')

const app = createApp()

/** 交卷：空 body 先被 zod 拒成 400，不走到查库那一步 */
const submit = () => request(app).post('/api/readings/not-an-id/submit').send({})

describe('POST /api/readings/:id/submit 限流', () => {
  it('20 次内放行（仍是业务错误），第 21 次 429', async () => {
    for (let index = 0; index < 20; index += 1) {
      const res = await submit()

      expect(res.status).toBe(400)
    }

    const blocked = await submit()

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.body.error.message).toContain('提交太频繁')
  })

  it('不误伤只读接口：/capacity 仍可用（md/21 W9 的教训）', async () => {
    const res = await request(app).get('/api/readings/capacity?targetWords=100')

    expect(res.status).toBe(200)
  })
})

describe('POST /api/words/batch 限流', () => {
  it('批量写有独立且更紧的桶：10 次后 429', async () => {
    // 空 body → 400，不写库
    for (let index = 0; index < 10; index += 1) {
      const res = await request(app).post('/api/words/batch').send({})

      expect(res.status).toBe(400)
    }

    const blocked = await request(app).post('/api/words/batch').send({})

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.message).toContain('批量导入太频繁')
  })
})
