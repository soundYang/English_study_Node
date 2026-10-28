import { authRequired } from '../../shared/errors.js'

/**
 * 鉴权中间件（md/33 §7）。
 *
 * 分工：
 *   currentUser —— 解析令牌，**永不拒绝**，只决定 req.userId 有没有值
 *   requireAuth —— 需要身份的接口才拦
 *
 * 拆开是因为健康检查和验证码接口也在同一串中间件里跑；
 * 让 currentUser 直接抛 401，会把公开接口一起打死。
 */

/**
 * 从 Authorization 头里取令牌。
 *
 * 只认 `Bearer <token>`，且对长度设上限：一个几 KB 的头没有理由进 sha256，
 * 也不该出现在日志里。解析不出来一律返回空串（= 当作未登录），不报错。
 *
 * @param {string|undefined} header
 * @returns {string}
 */
export function parseBearer(header) {
  if (typeof header !== 'string') return ''

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match) return ''

  const token = match[1]
  return token.length > 200 ? '' : token
}

/** 401：没有身份。挂在这组路由之前，公开路由不要挂 */
export function requireAuth(req, res, next) {
  if (req.userId) return next()
  next(authRequired())
}
