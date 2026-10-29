import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from '../../../config/index.js'
import { logger } from '../../../shared/logger.js'
import { ocrFailed } from '../../../shared/errors.js'

/**
 * 图片 OCR（md/48 §7）。
 *
 * 抽成一个独立模块是为了**可替换**：以后换云 OCR 只改这个文件，
 * 上层抽取器只认「Buffer 进去，纯文本出来」。测试也一律 mock 它——
 * 真跑一次 tesseract 要几秒到十几秒，用例根本跑不动，而且识别结果
 * 会随模型版本变，断言准确率等于给自己埋不稳定的测试。
 *
 * worker 是重资源（独立线程 + WASM 实例），所以做成池：
 *   · 空闲 worker 复用，不会每张图重建（冷启动要 1–2 秒）
 *   · 池大小由 OCR_WORKERS 控制，超过就排队
 *   · 识别超时的 worker **直接销毁**而不是放回池里——
 *     超时的那次识别可能还在跑，放回去会污染下一个请求
 */

/** @type {{ workers: any[], idle: any[], waiting: Array<{resolve:(w:any)=>void, reject:(e:any)=>void}>, creating: number, failedAt: number }} */
const state = { workers: [], idle: [], waiting: [], creating: 0, failedAt: 0 }

/**
 * 仓库自带的语言模型目录（data/ocr/eng.traineddata.gz）。
 *
 * 从模块位置反推项目根，而不是用 `process.cwd()`：
 * 用 pm2 / systemd 起服务时 cwd 不一定是项目根，模型会「莫名找不到」。
 */
const BUNDLED_LANG_DIR = fileURLToPath(new URL('../../../../data/ocr/', import.meta.url))

/** 创建失败后的冷却时间：失败一次就不再立刻重试，避免把线程泄漏放大 */
const CREATE_COOLDOWN_MS = 60_000

/**
 * 模型解析顺序：显式配置 > 仓库自带 > tesseract 默认（CDN）。
 *
 * 返回 null 表示交给 tesseract 自己去 CDN 下载——服务器有网时仍能工作，
 * 只是慢，且第一次要下 2MB 左右。
 */
function resolveLangPath() {
  if (config.ocrLangPath) return config.ocrLangPath
  if (hasLocalModel(BUNDLED_LANG_DIR)) return BUNDLED_LANG_DIR

  logger.warn(
    { dir: BUNDLED_LANG_DIR, lang: config.ocrLang },
    'bundled ocr model not found, fallback to cdn',
  )

  return null
}

/** 本地模型文件是否存在：tesseract 认 `xxx.traineddata` 和 `xxx.traineddata.gz` 两种 */
function hasLocalModel(dir) {
  const langs = String(config.ocrLang).split('+').filter(Boolean)

  return langs.every(
    (lang) => existsSync(join(dir, `${lang}.traineddata`)) || existsSync(join(dir, `${lang}.traineddata.gz`)),
  )
}

/**
 * 起 worker 前先确认模型在不在。
 *
 * 不检查的话，缺模型会在 worker 线程里抛 ENOENT，而 tesseract 的
 * 失败路径没法拿到 worker 句柄去 terminate——那条线程会一直挂着。
 * 宁可在这里用一次 `existsSync` 换一个干净的失败。
 */
function assertModelReady(langPath) {
  if (!langPath) return
  if (config.ocrCachePath && hasLocalModel(config.ocrCachePath)) return
  if (hasLocalModel(langPath)) return

  throw ocrFailed(
    `图片识别未就绪：缺少语言模型 ${config.ocrLang}.traineddata，请先执行 npm run fetch:ocr`,
  )
}

async function createWorker() {
  const langPath = resolveLangPath()

  assertModelReady(langPath)

  // 动态 import：没开 OCR 的环境（或只跑单元测试）不该付这个加载成本
  const { createWorker: create } = await import('tesseract.js')

  const options = {
    // tesseract 收到 reject 时若没有 errorHandler，会在消息回调里直接 throw，
    // 变成**未捕获异常**——一张图就能把整个进程带走。这里必须给一个。
    errorHandler: (error) => logger.warn({ err: error }, 'ocr worker error'),
  }

  if (langPath) {
    options.langPath = langPath
    // 模型就放在本地，缓存反而会在 cwd 写一个 4MB 的 eng.traineddata；
    // 用户显式配了 OCR_CACHE_PATH 才让 tesseract 走缓存。
    if (config.ocrCachePath) options.cachePath = config.ocrCachePath
    else options.cacheMethod = 'none'
  } else if (config.ocrCachePath) {
    options.cachePath = config.ocrCachePath
  }

  // oem = 1（LSTM），也是 tesseract 默认值，显式写出来避免版本升级后默认值变化
  return create(config.ocrLang, 1, options)
}

async function acquire() {
  if (state.idle.length > 0) return state.idle.pop()

  if (state.workers.length + state.creating < config.ocrWorkers) return spawn()

  return new Promise((resolve, reject) => state.waiting.push({ resolve, reject }))
}

/**
 * 起一个新 worker。
 *
 * 失败时必须把排队的人也拒掉：否则他们的请求会挂到连接超时，
 * 而用户看到的只是「一直在转圈」。
 */
async function spawn() {
  // 刚失败过就先别再拉线程：失败路径拿不到 worker 句柄去 terminate，
  // 每失败一次就漏一条线程，冷却把漏的速度压到最多 1 条/分钟
  if (state.failedAt && Date.now() - state.failedAt < CREATE_COOLDOWN_MS) {
    const error = ocrFailed('图片识别暂时不可用，请稍后再试，或直接粘贴文本')

    // 池里一个 worker 都没有 = 没人会 release，排队的人等不到结果
    if (state.workers.length === 0) failWaiters(error)

    throw error
  }

  state.creating += 1

  try {
    const worker = await createWorker()

    state.workers.push(worker)
    state.failedAt = 0

    return worker
  } catch (error) {
    state.failedAt = Date.now()
    failWaiters(error)
    throw error
  } finally {
    state.creating -= 1
  }
}

function failWaiters(error) {
  for (const waiter of state.waiting.splice(0)) waiter.reject(error)
}

function release(worker) {
  const next = state.waiting.shift()

  if (next) next.resolve(worker)
  else state.idle.push(worker)
}

/** 销毁一个不可信或出错的 worker，并把它从池里摘掉 */
function discard(worker) {
  state.workers = state.workers.filter((item) => item !== worker)
  state.idle = state.idle.filter((item) => item !== worker)

  Promise.resolve()
    .then(() => worker.terminate())
    .catch((error) => logger.warn({ err: error }, 'ocr worker terminate failed'))

  // 还在排队的人等的是空闲 worker；刚销毁的那个不会回来了，补一个新的
  if (state.waiting.length > 0 && state.workers.length + state.creating < config.ocrWorkers) {
    spawn()
      .then(release)
      .catch(() => {})
  }
}

function withTimeout(promise, ms) {
  let timer

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR_TIMEOUT')), ms)
    // 不阻塞进程退出
    if (typeof timer.unref === 'function') timer.unref()
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param {Buffer} imageBuffer
 * @returns {Promise<string>} 识别出的纯文本；可能是空串（图片里没有文字）
 */
export async function recognizeImage(imageBuffer) {
  if (!config.ocrEnabled) {
    throw ocrFailed('图片识别暂未开放，请改用粘贴文本或上传 Word / Excel')
  }

  let worker = null

  try {
    worker = await acquire()

    const result = await withTimeout(worker.recognize(imageBuffer), config.ocrTimeoutMs)
    const text = result?.data?.text ?? ''

    release(worker)

    return text
  } catch (error) {
    if (worker) discard(worker)

    if (error?.message === 'OCR_TIMEOUT') {
      throw ocrFailed('图片识别超时了，换张小一点、清楚一点的图片再试')
    }

    // acquire() 里已经给出了更准确的说明（缺模型 / 冷却中），不要被泛化提示覆盖
    if (error?.name === 'ApiError') throw error

    logger.warn({ err: error }, 'ocr recognize failed')
    throw ocrFailed('图片没能识别出来，换一张清楚的截图，或直接粘贴文本')
  }
}

/** 进程退出 / 测试收尾用；生产不会主动调用（worker 随进程一起结束） */
export async function shutdownOcr() {
  const workers = [...state.workers]

  state.workers = []
  state.idle = []

  await Promise.all(
    workers.map((worker) =>
      Promise.resolve()
        .then(() => worker.terminate())
        .catch(() => {}),
    ),
  )
}
