import request from 'supertest'
import { describe, expect, it } from 'vitest'

/**
 * 基础词汇库的游客只读接口（md/50）。
 *
 * 这个文件在 `AUTH_ENFORCED=true` 下跑：游客能拿到的唯一理由就是
 * 这条路由**没有**挂在 requireAuth 后面。顺带守住另一条线——
 * 现有 `/api/basic-words` 在同一个环境下仍然必须 401，
 * 否则「公开只读」就变成了「把写接口也放开了」。
 */
process.env.AUTH_ENFORCED = 'true'

const { createApp } = await import('../app.js')
const { createCaptcha } = await import('../modules/auth/captcha.service.js')

const app = createApp()

const publicGet = (query = '') => request(app).get(`/api/public/basic-words${query}`)

async function registerAndGetToken() {
  const { captchaId } = await createCaptcha({ text: 'AB3D' })

  const res = await request(app).post('/api/auth/register').send({
    username: 'PublicViewUser',
    password: 'Passw0rd1',
    captchaId,
    captchaCode: 'AB3D',
  })

  expect(res.status).toBe(201)

  return res.body.token
}

describe('GET /api/public/basic-words', () => {
  it('游客不带令牌也能拿到全量静态词表', async () => {
    const res = await publicGet()

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(650)
    expect(res.body.page).toBe(1)
    expect(res.body.pageSize).toBe(50)
    expect(res.body.items).toHaveLength(50)
    expect(res.body.items[0]).toMatchObject({
      word: 'a',
      personalStatus: null,
      removed: false,
      wordId: null,
    })
  })

  it('个人状态一律为空，数字卡里学习 / 移除都是 0', async () => {
    // 拿最后一页，避免只检查到首屏
    const res = await publicGet('?pageSize=100&page=7')

    expect(res.status).toBe(200)
    expect(res.body.page).toBe(7)
    expect(res.body.items).toHaveLength(50)

    for (const item of res.body.items) {
      expect(item.personalStatus).toBeNull()
      expect(item.removed).toBe(false)
      expect(item.wordId).toBeNull()
    }

    expect(res.body.counts).toMatchObject({
      all: 650,
      basic: 600,
      calendar: 19,
      abbreviation: 32,
      removable: 421,
      functionWord: 179,
      learned: 0,
      removed: 0,
      untouched: 650,
    })
  })

  it('分组、搜索、分页与现有列表同一口径', async () => {
    const abbreviations = await publicGet('?group=abbreviation')
    expect(abbreviations.body.total).toBe(32)

    const search = await publicGet('?q=according')
    expect(search.body.items[0].word).toBe('according')

    // 页码越界收敛到末页，与 /api/basic-words 一致（默认 50/页 → 13 页）
    const overflow = await publicGet('?page=999')
    expect(overflow.body.page).toBe(13)
  })

  it('带不带令牌结果完全一致（公开接口忽略身份）', async () => {
    const token = await registerAndGetToken()

    const guest = await publicGet('?q=according&pageSize=10')
    const logged = await request(app)
      .get('/api/public/basic-words?q=according&pageSize=10')
      .set('Authorization', `Bearer ${token}`)

    expect(logged.status).toBe(200)
    expect(logged.body).toEqual(guest.body)
  })

  it('现有 /api/basic-words 仍然要求登录', async () => {
    const res = await request(app).get('/api/basic-words')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('参数非法 → 400，不会把错误参数当成默认值', async () => {
    const pageSize = await publicGet('?pageSize=101')
    expect(pageSize.status).toBe(400)
    expect(pageSize.body.error.code).toBe('INVALID_REQUEST')

    const longQuery = await publicGet(`?q=${'a'.repeat(46)}`)
    expect(longQuery.status).toBe(400)
    expect(longQuery.body.error.code).toBe('INVALID_REQUEST')
  })

  it('响应带 5 分钟公共缓存头', async () => {
    const res = await publicGet()

    expect(res.headers['cache-control']).toContain('public')
    expect(res.headers['cache-control']).toContain('max-age=300')
  })
})
