import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OCR worker 池（md/48 §7、§15.2）。
 *
 * 其余用例都把 `ocr.js` 整个 mock 掉，池本身没人测。这里反过来：
 * tesseract 是 mock，测的是「复用 / 失败 / 冷却」这几条**只会出事一次**的路径——
 * 它们真在线上出问题时的表现是「请求挂到超时」或「线程越漏越多」，
 * 光靠手工点几下根本发现不了。
 */

const { create } = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('tesseract.js', () => ({ createWorker: create }))

function makeWorker(text = 'abandon\n') {
  return {
    recognize: vi.fn(async () => ({ data: { text } })),
    terminate: vi.fn(async () => {}),
  }
}

/** 每个用例都拿一份干净的模块状态（池是模块级变量） */
async function loadOcr() {
  vi.resetModules()
  return import('../modules/words/import/ocr.js')
}

beforeEach(() => {
  create.mockReset()
})

describe('OCR worker 池', () => {
  it('串行请求复用同一个 worker，不会每张图新建线程', async () => {
    create.mockResolvedValue(makeWorker())
    const { recognizeImage } = await loadOcr()

    const first = await recognizeImage(Buffer.from('a'))
    const second = await recognizeImage(Buffer.from('b'))

    expect(first).toBe('abandon\n')
    expect(second).toBe('abandon\n')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('worker 创建失败：返回 422，且 60 秒内不再重试', async () => {
    create.mockRejectedValue(new Error('fetch failed'))
    const { recognizeImage } = await loadOcr()

    await expect(recognizeImage(Buffer.from('a'))).rejects.toMatchObject({ code: 'OCR_FAILED' })
    await expect(recognizeImage(Buffer.from('a'))).rejects.toMatchObject({ code: 'OCR_FAILED' })

    // 第二次没有真的去拉线程：失败路径拿不到 worker 句柄去 terminate，
    // 不冷却的话每次失败都会漏一条线程
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('识别失败后销毁 worker，下一次换新的', async () => {
    const broken = makeWorker()
    broken.recognize.mockRejectedValueOnce(new Error('识别崩了'))

    create.mockResolvedValueOnce(broken).mockResolvedValue(makeWorker('ability\n'))

    const { recognizeImage } = await loadOcr()

    await expect(recognizeImage(Buffer.from('a'))).rejects.toMatchObject({ code: 'OCR_FAILED' })
    expect(broken.terminate).toHaveBeenCalled()

    await expect(recognizeImage(Buffer.from('a'))).resolves.toBe('ability\n')
    expect(create).toHaveBeenCalledTimes(2)
  })
})
