import { adminAuthRequired } from '../../shared/errors.js'
import { parseBearer } from '../auth/auth.middleware.js'
import { resolveAdminToken } from './admin.service.js'

/**
 * 管理端鉴权（md/37 §2.4）。
 *
 * **与用户侧的 requireAuth 完全独立**：读的是 `admin_sessions`，
 * 写的是 `req.admin`。用户令牌进不来、管理员令牌也进不了 `/api/profile`。
 *
 * 解析与拒绝合成一步：管理端没有「匿名可用」的接口（登录本身不经过这里），
 * 不需要像 currentUser 那样先放行再判断。
 */
export async function requireAdmin(req, res, next) {
  const token = parseBearer(req.headers.authorization)
  const session = await resolveAdminToken(token)

  if (!session) return next(adminAuthRequired())

  req.admin = {
    username: session.username,
    sessionId: session._id,
    expiresAt: session.expiresAt,
    token,
  }

  next()
}
