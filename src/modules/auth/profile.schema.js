import { z } from 'zod'

import { passwordRule } from './auth.schema.js'

/**
 * 个人中心的请求体（md/33 §6.2）。
 *
 * 长度与 users 模型里的 maxlength 保持一致：模型是兜底，这里是给用户看的提示。
 * 两者不一致时，用户会先看到一个模型层的 ValidationError（500 元凶）。
 */

/** 昵称：允许中文，trim 后不能为空 */
export const nicknameRule = z
  .string({ error: '请输入昵称' })
  .trim()
  .min(1, '昵称不能为空')
  .max(20, '昵称最多 20 个字符')

/** 个性签名选填，空串合法（= 清空） */
export const signatureRule = z
  .string({ error: '个性签名必须是文本' })
  .trim()
  .max(60, '个性签名最多 60 个字符')

/**
 * PATCH 语义：**没传的字段保持原值**，所以两个字段都是 optional。
 *
 * 空对象也放行——前端保存一个没改动的表单不该报错。
 */
export const updateProfileSchema = z.object({
  nickname: nicknameRule.optional(),
  signature: signatureRule.optional(),
})

export const changePasswordSchema = z
  .object({
    // 旧密码只校验非空：规则是给新密码用的，老密码可能不满足现在的强度
    oldPassword: z.string({ error: '请输入当前密码' }).min(1, '请输入当前密码').max(64, '密码太长'),
    newPassword: passwordRule,
  })
  .refine((value) => value.oldPassword !== value.newPassword, {
    message: '新密码不能与当前密码相同',
    path: ['newPassword'],
  })
