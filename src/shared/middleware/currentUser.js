import { config } from '../../config/index.js'

/**
 * MVP 没有登录，所有请求都归属 .env 里的 DEFAULT_USER_ID。
 * 将来接鉴权时，只需要把这个中间件换成真正的解析逻辑，
 * 下游 service 一律读 req.userId，不用改。
 */
export function currentUser(req, res, next) {
  req.userId = config.defaultUserId
  next()
}
