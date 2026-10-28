import { badRequest } from '../../shared/errors.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { SESSION_TTL_SECONDS, toUserDto } from './auth.service.js'
import { hashPassword, verifyPassword } from './password.js'
import { changePasswordSchema, updateProfileSchema } from './profile.schema.js'
import { Session } from './session.model.js'
import { User } from './user.model.js'

/**
 * 个人中心（md/33 §6.1、§4.4）。
 *
 * 这里的 user / session 都来自 req.auth —— 也就是「确实登了录」的那个人，
 * 不是 req.userId（那只是数据域，AUTH_ENFORCED=false 时还有个 local-user 兜底）。
 */

/** GET /profile */
export function getProfile({ user }) {
  return { user: toUserDto(user) }
}

/**
 * PATCH /profile：只改传了的字段。
 *
 * 一次性 `updateOne` 而不是 `user.save()`：save 会把整个文档写回去，
 * 两个标签页同时改昵称和签名时，后写的会把先写的覆盖掉。
 */
export async function updateProfile({ user, body }) {
  const input = parseOrThrow(updateProfileSchema, body)
  const patch = {}

  if (input.nickname !== undefined) patch.nickname = input.nickname
  if (input.signature !== undefined) patch.signature = input.signature

  if (Object.keys(patch).length > 0) {
    await User.updateOne({ _id: user._id }, { $set: patch })
    // 同步到手里的文档，响应不必再查一次库
    Object.assign(user, patch)
  }

  return { user: toUserDto(user) }
}

/**
 * POST /profile/password。
 *
 * 旧密码错**必须是 400**，不能是 401：前端 `request.js` 见到 401 就清 token，
 * 用户只是输错一格，会被顺手登出。
 *
 * 成功后的动作见 md/33 §4.4：保留当前会话并续满，删掉其余全部会话。
 */
export async function changePassword({ user, session, body }) {
  const input = parseOrThrow(changePasswordSchema, body)

  const passed = await verifyPassword(input.oldPassword, user.passwordHash)
  if (!passed) throw badRequest('当前密码不正确', 'oldPassword')

  const passwordHash = await hashPassword(input.newPassword)
  await User.updateOne({ _id: user._id }, { $set: { passwordHash } })

  const ttlSeconds = session.ttlSeconds || SESSION_TTL_SECONDS.standard
  await Session.updateOne(
    { _id: session._id },
    { $set: { expiresAt: new Date(Date.now() + ttlSeconds * 1000), lastSeenAt: new Date() } },
  )
  await Session.deleteMany({ userId: user._id, _id: { $ne: session._id } })

  return { ok: true }
}
