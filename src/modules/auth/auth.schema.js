import { z } from 'zod'

/**
 * 注册与登录的请求体（md/33 §6.2）。
 *
 * 校验放在这里而不是模型层：模型里的 maxlength 是兜底，
 * 用户看到的必须是「用户名至少 3 个字」这种能照着改的提示。
 */

/** 用户名只允许字母数字下划线：中文请用昵称，昵称不参与登录 */
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/
/** 只认大陆手机号。既然是选填且不验证，格式就是唯一能守的东西 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/

export const usernameRule = z
  .string({ error: '请输入用户名' })
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(20, '用户名最多 20 个字符')
  .regex(USERNAME_PATTERN, '用户名只能包含字母、数字和下划线')

/**
 * 密码规则：8–64 位，至少一个字母和一个数字。
 *
 * 不强制大小写与符号——这个项目没有口令轮换策略、也没有管理员，
 * 过严的规则只会把用户推向「Abc12345!」这种更难记的写法。
 */
export const passwordRule = z
  .string({ error: '请输入密码' })
  .min(8, '密码至少 8 位')
  .max(64, '密码最多 64 位')
  .regex(/[A-Za-z]/, '密码需要包含字母')
  .regex(/\d/, '密码需要包含数字')

/** 选填手机号：空串与 undefined 都归一成 undefined，不往库里写空字符串 */
const optionalPhone = z
  .union([z.literal(''), z.string().trim().regex(PHONE_PATTERN, '手机号格式不正确')], {
    error: '手机号格式不正确',
  })
  .optional()
  .transform((value) => (value ? value : undefined))

const captchaIdRule = z
  .string({ error: '验证码已失效，请刷新' })
  .regex(/^[0-9a-fA-F]{24}$/, '验证码已失效，请刷新')

const captchaCodeRule = z
  .string({ error: '请输入图形验证码' })
  .trim()
  .min(4, '请输入 4 位图形验证码')
  .max(8, '图形验证码不正确')

export const registerSchema = z.object({
  username: usernameRule,
  password: passwordRule,
  phone: optionalPhone,
  captchaId: captchaIdRule,
  captchaCode: captchaCodeRule,
})

export const loginSchema = z.object({
  // 用户名或手机号，二者都走这一格；后端按 usernameLower 或 phone 各查一次
  usernameOrPhone: z
    .string({ error: '请输入用户名或手机号' })
    .trim()
    .min(1, '请输入用户名或手机号')
    .max(64, '用户名或手机号太长'),
  // 登录不校验强度：规则是给新密码用的，老密码只要能对上就行
  password: z.string({ error: '请输入密码' }).min(1, '请输入密码').max(64, '密码太长'),
  rememberMe: z.boolean({ error: 'rememberMe 必须是布尔值' }).optional().default(false),
  // 只在「连续失败 5 次之后」才强制要求，所以是 optional（md/33 §10）
  captchaId: captchaIdRule.optional(),
  captchaCode: captchaCodeRule.optional(),
})
