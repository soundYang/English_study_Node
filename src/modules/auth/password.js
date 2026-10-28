import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

/**
 * 密码哈希（md/33 §4.1）。
 *
 * 用 Node 内置的 scrypt，不装 bcrypt：bcrypt 是原生模块，Windows 上要 MSVC 工具链，
 * `npm i` 会多一道坎；scrypt 已被 RFC 7914 标准化，抗 GPU 能力不低于 bcrypt。
 *
 * 参数**写进存储串**，不是只写在代码里。将来调大 N 时，老用户的密码仍按当时的
 * 参数校验，不需要让他们全部重设密码——`needsRehash()` 负责提示「该换一套参数了」。
 */
export const SCRYPT_PARAMS = Object.freeze({
  // 128 × N × r ≈ 16.8 MB 内存/次，单次约 50–100 ms。
  // 这个数字同时决定了登录接口能扛住的暴力尝试次数，不要为了「快一点」调小。
  N: 16384,
  r: 8,
  p: 1,
  keylen: 32,
  saltBytes: 16,
})

const PREFIX = 'scrypt'

/**
 * 解析字符串时需要的内存上限。
 *
 * 从库里读出来的参数理论上可信，但一行脏数据写上 `N=1<<30` 就能把一个请求拖成
 * 几十秒的内存分配。校验时按这两个上限直接拒绝，比信任库更省事。
 */
const MAX_N = 1 << 20
const MAX_R = 32

/** scrypt 的内存需求是 128 × N × r，留一倍余量给实现自身的开销 */
function memoryFor(N, r) {
  return 128 * N * r * 2
}

async function derive(password, salt, { N, r, p, keylen }) {
  return scryptAsync(password, salt, keylen, { N, r, p, maxmem: memoryFor(N, r) })
}

/**
 * 生成存储串：`scrypt$N$r$p$<base64 salt>$<base64 hash>`
 *
 * @param {string} password 明文密码，只在这一次调用里存在
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    // 传空密码是调用方的 bug，不能静默生成一个「空密码也能过」的哈希
    throw new TypeError('hashPassword 需要一个非空字符串')
  }

  const salt = randomBytes(SCRYPT_PARAMS.saltBytes)
  const derived = await derive(password, salt, SCRYPT_PARAMS)

  return [
    PREFIX,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

/**
 * 解析存储串；任何不合规的形态都返回 null，由调用方当成「校验失败」处理。
 * 这里不抛异常：脏数据应该表现为「登录不上」，而不是整站 500。
 */
function parseHash(stored) {
  if (typeof stored !== 'string') return null

  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return null

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])

  // N 必须是 2 的幂且大于 1，这是 scrypt 的硬性要求
  const validNumbers =
    Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0 && N <= MAX_N
    && Number.isInteger(r) && r > 0 && r <= MAX_R
    && Number.isInteger(p) && p > 0 && p <= MAX_R
  if (!validNumbers) return null

  const salt = Buffer.from(parts[4], 'base64')
  const hash = Buffer.from(parts[5], 'base64')
  if (salt.length === 0 || hash.length === 0) return null

  return { N, r, p, salt, hash, keylen: hash.length }
}

/**
 * 校验密码。
 *
 * @param {string} password 用户输入的明文
 * @param {string} stored 库里的存储串
 * @returns {Promise<boolean>} 存储串不合规一律 false，不抛
 */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored)
  if (!parsed) return false
  if (typeof password !== 'string' || password.length === 0) return false

  const derived = await derive(password, parsed.salt, parsed)

  // timingSafeEqual 在两个 buffer 长度不同时**直接抛 RangeError**，不是返回 false。
  // 正常数据不会走到这里（keylen 就是从 hash 长度取的），防的是截断过的脏数据。
  if (derived.length !== parsed.hash.length) return false

  return timingSafeEqual(derived, parsed.hash)
}

/**
 * 这套参数是不是该换了。
 *
 * 加盐哈希无法批量升级，只能在用户下次登录成功时用明文重新算一次。
 * 本函数只负责判断，什么时候写回由调用方决定（md/33 §4.4）。
 */
export function needsRehash(stored) {
  const parsed = parseHash(stored)
  if (!parsed) return true

  return (
    parsed.N !== SCRYPT_PARAMS.N
    || parsed.r !== SCRYPT_PARAMS.r
    || parsed.p !== SCRYPT_PARAMS.p
    || parsed.keylen !== SCRYPT_PARAMS.keylen
  )
}

/**
 * 缓存的是 **Promise 而不是结果**：两个请求同时走到这里时，
 * `x ??= await ...` 会让两边都看到 null、各算一次；
 * 先把 Promise 存下来，第二次调用直接拿到同一个（尚未完成的）计算。
 */
let dummyHashPromise = null

/**
 * 一个固定密码的哈希，只用来「陪跑」。
 *
 * 登录时如果用户不存在就直接返回，响应会明显快于「用户存在但密码错」——
 * 这个时间差足够枚举账号。先拿它跑一次完整的 verify，两条路径耗时才对得上。
 * 惰性生成：进程启动时不需要为它多花 80 ms。
 */
export function getDummyHash() {
  dummyHashPromise ??= hashPassword(randomBytes(16).toString('hex'))
  return dummyHashPromise
}
