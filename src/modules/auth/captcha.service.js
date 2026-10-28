import { createHash, timingSafeEqual } from 'node:crypto'

import mongoose from 'mongoose'

import { captchaExpired, captchaInvalid } from '../../shared/errors.js'
import { randomText, renderSvg } from './captcha.js'
import { Captcha } from './captcha.model.js'

/**
 * 验证码的生成与校验（md/33 §3.3 / §5.3）。
 *
 * 与 captcha.js 的分工：那边只管画，这边只管库与错误。
 */

/** 5 分钟。够一个正常人看清并输入，又足够短到「拿到了也没多少用」 */
export const CAPTCHA_TTL_SECONDS = 300

/** 答案一律 trim + 小写后比较，用户按 CapsLock 不该被判错 */
function normalize(answer) {
  return String(answer ?? '').trim().toLowerCase()
}

/**
 * 答案的哈希。加盐用的是 captchaId——它本身就是随机 ObjectId，
 * 所以彩虹表对这里没有意义（4 个字符的答案空间只有 32^4，不加盐可以秒查）。
 *
 * @param {string} captchaId
 * @param {string} answer
 */
export function hashAnswer(captchaId, answer) {
  return createHash('sha256').update(`${captchaId}:${normalize(answer)}`).digest('hex')
}

/**
 * 下发一张验证码。
 *
 * @param {{ ip?: string, text?: string }} [options]
 *   `text` **只给测试用**：路由永远不传，答案必须由服务端生成。
 * @returns {Promise<{ captchaId: string, svg: string, expiresIn: number }>}
 */
export async function createCaptcha({ ip = '', text } = {}) {
  const answer = text ?? randomText()

  // _id 在 save 之前就已经生成，可以直接参与哈希——不需要先存一次再回写
  const captcha = new Captcha({
    answerHash: '',
    expiresAt: new Date(Date.now() + CAPTCHA_TTL_SECONDS * 1000),
    ip,
  })
  captcha.answerHash = hashAnswer(String(captcha._id), answer)

  await captcha.save()

  return {
    captchaId: String(captcha._id),
    svg: renderSvg(answer),
    expiresIn: CAPTCHA_TTL_SECONDS,
  }
}

/**
 * 校验并**消耗**一张验证码。
 *
 * 「查出来即删除」是这里唯一重要的事：`findOneAndDelete` 把
 * 「存在性判断」和「作废」合并成一次原子操作，并发猜两次时只有一个请求
 * 拿得到文档。换成「先查再删」，两个请求都会看到同一张图，一次性就没了。
 *
 * 失败分两种：
 *   CAPTCHA_EXPIRED —— 什么都没拿到（过期 / 用过了 / id 不存在）
 *   CAPTCHA_INVALID —— 拿到了但答案不对（这张图同样已经作废）
 *
 * @param {{ captchaId: string, answer: string }} payload
 * @returns {Promise<true>} 失败一律抛 ApiError
 */
export async function verifyCaptcha({ captchaId, answer }) {
  // 畸形 id 直接当过期处理：让它走到 findOneAndDelete 会抛 CastError，变成 500
  if (!mongoose.isValidObjectId(captchaId)) throw captchaExpired()

  // expiresAt 的比较必须写在查询里：TTL 是后台线程在清，过期文档可能还躺着
  const doc = await Captcha.findOneAndDelete({
    _id: captchaId,
    expiresAt: { $gt: new Date() },
  })

  if (!doc) throw captchaExpired()

  const expected = Buffer.from(doc.answerHash, 'hex')
  const actual = Buffer.from(hashAnswer(String(doc._id), answer), 'hex')

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw captchaInvalid()
  }

  return true
}
