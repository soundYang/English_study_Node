#!/usr/bin/env node
/**
 * 生成自备 API Key 的加密主密钥（md/43 §8）。
 *
 * 用法：
 *   node scripts/gen-user-key-secret.mjs
 *
 * 输出一行可直接粘进 `.env`：
 *   USER_API_KEY_SECRET=<32 字节 base64>
 *
 * 为什么不让脚本自己写 `.env`：
 *   与 hash-admin-password.mjs 同一个理由——改配置时人应该看见自己粘了哪一行，
 *   而不是让脚本在背后改文件。
 *
 * 轮换：
 *   1. 把当前值挪到 USER_API_KEY_SECRET_PREVIOUS；
 *   2. 用本脚本生成新值填 USER_API_KEY_SECRET；
 *   3. 重启后新旧密文都能解开（解密按密文里的 kid 选密钥）。
 *   把 _PREVIOUS 清空之前，旧的 Key 仍可用；清空后就只能让用户重新导入。
 *
 * **丢失主密钥 = 存量的 Key 全部解不开**（fail-open 回免费路径，用户需要重导）。
 * 这个值不要提交进仓库，也不要贴进聊天工具。
 */
import { randomBytes } from 'node:crypto'

// 32 字节正好是 AES-256 的密钥长度；HKDF 再派生，仍然以此熵为上限
const secret = randomBytes(32).toString('base64')

console.log('# 请把这行粘进 .env（不要提交进仓库）')
console.log(`USER_API_KEY_SECRET=${secret}`)
