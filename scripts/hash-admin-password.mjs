#!/usr/bin/env node
/**
 * 生成管理员密码哈希（md/37 §2.1）。
 *
 * 用法：
 *   node scripts/hash-admin-password.mjs '你的密码'
 *
 * 输出一行可直接粘进 `.env`：
 *   ADMIN_PASSWORD_HASH=scrypt$16384$8$1$<salt>$<hash>
 *
 * 为什么不让脚本自己写 `.env`：
 *   写文件会把明文命令留在 shell history 之外、却把哈希直接落盘，
 *   看起来方便，实际让人失去「我到底改了哪一行」的确认机会。
 *   打印出来手动粘，只需要一次。
 *
 * 不打印明文；也不读 `.env`——改密码不依赖当前配置。
 */
import { hashPassword, SCRYPT_PARAMS } from '../src/modules/auth/password.js'

const password = process.argv[2]

if (!password) {
  console.error('用法：node scripts/hash-admin-password.mjs <新密码>')
  console.error('提示：密码请用引号包起来，避免 shell 把 $ 等字符吃掉。')
  process.exit(1)
}

// 与用户注册同一套强度规则（auth.schema.js 的 passwordRule）：
// 管理员密码没有理由比用户密码更弱
if (password.length < 8) {
  console.error('密码至少 8 位')
  process.exit(1)
}

if (password.length > 64) {
  console.error('密码最多 64 位')
  process.exit(1)
}

const hash = await hashPassword(password)

console.log(`# scrypt N=${SCRYPT_PARAMS.N} r=${SCRYPT_PARAMS.r} p=${SCRYPT_PARAMS.p}`)
console.log(`ADMIN_PASSWORD_HASH=${hash}`)
