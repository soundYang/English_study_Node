import { config } from '../../config/index.js'
import { parseBearer } from '../../modules/auth/auth.middleware.js'
import { resolveSession } from '../../modules/auth/auth.service.js'

/**
 * 把请求里的令牌解析成 `req.userId`（md/33 §7.1）。
 *
 * 这一步**只解析、不拒绝**：
 *   · 令牌有效 → `req.userId` 是该用户的 `dataKey`（**不是** users._id，见 user.model.js）
 *   · 无令牌 / 令牌无效 → 强制鉴权开关打开时留空（由 requireAuth 给 401），
 *     关闭时回落到 DEFAULT_USER_ID，行为与没有登录体系时完全一致
 *
 * 所以「后端先上线、前端还没做登录页」不会把站点打成全站 401：
 * 开关关着的时候，带了令牌就按令牌走，没带就还是老的 local-user。
 *
 * 下游 service 一律读 `req.userId`，一个字都不用改——这正是当初把它单独
 * 抽成中间件的原因。
 */
export async function currentUser(req, res, next) {
  const token = parseBearer(req.headers.authorization)

  // 解析失败返回 null 而不是抛异常：健康检查、验证码这些公开接口也走这串中间件，
  // 一个过期令牌不该让它们变成 500
  req.auth = token ? await resolveSession(token) : null

  req.userId = req.auth?.user?.dataKey ?? (config.authEnforced ? null : config.defaultUserId)

  next()
}
