import { randomInt } from 'node:crypto'

/**
 * 图形验证码的**纯绘制**部分（md/33 §5）。
 *
 * 这里不碰数据库、不碰错误处理——只管「给定 4 个字符，画成一张 SVG」。
 * 生成与校验在 captcha.service.js，两边分开是为了让这一份能单独拿去做视觉调试。
 *
 * 红线：**字符不能用 <text> 输出**。
 * SVG 是以 JSON 字符串回给前端的，脚本一个正则就能把 <text> 里的答案读走，
 * 那比「图形容易被 OCR」严重得多——等于完全没做验证码。
 * 所以字符由这里的一套笔画字库画成 <path>，SVG 里不存在任何可读的文字。
 */

/** 去掉了 I / O / 0 / 1：它们和 1 / 0 / O 互为形近，人眼也会输错 */
export const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 笔画字库：每个字符由若干条折线组成，坐标写在 4 × 6 的网格里（y 轴向下）。
 * 绘制时整体乘 4 → 16 × 24 px。
 *
 * 用笔画而不是字体，是为了不引入任何字体文件与字形解析依赖（md/33 §5.1）。
 * 代价是字形偏「图纸感」，不如字体渲染圆润；4 个字符的小图上可以接受。
 */
const GLYPHS = Object.freeze({
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 3.6], [3, 3.6]]],
  B: [[[0, 6], [0, 0], [3, 0], [4, 1.5], [3, 3], [0, 3]], [[0, 3], [3, 3], [4, 4.5], [3, 6], [0, 6]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1.5], [0, 4.5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6]], [[0, 0], [2.5, 0], [4, 1.5], [4, 4.5], [2.5, 6], [0, 6]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1.5], [0, 4.5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.5, 3.5]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  J: [[[4, 0], [4, 4.5], [3, 6], [1, 6], [0, 4.5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.5, 2.5], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3.5], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1.5], [3, 3], [0, 3]]],
  Q: [[[1, 0], [3, 0], [4, 1.5], [4, 4.5], [3, 6], [1, 6], [0, 4.5], [0, 1.5], [1, 0]], [[2.5, 4], [4, 6.5]]],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1.5], [3, 3], [0, 3]], [[1.8, 3], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1.5], [1, 3], [3, 3], [4, 4.5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 4.5], [1, 6], [3, 6], [4, 4.5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 2.5], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  2: [[[0, 1.5], [1, 0], [3, 0], [4, 1.5], [4, 2.5], [0, 6], [4, 6]]],
  3: [[[0, 0], [4, 0], [1.5, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  5: [[[4, 0], [0, 0], [0, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [1, 6], [0, 5]]],
  6: [[[3.5, 0], [1.5, 0], [0, 2], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [3, 2.5], [0, 2.5]]],
  7: [[[0, 0], [4, 0], [1.5, 6]]],
  8: [
    [[1, 0], [3, 0], [4, 1.5], [3, 3], [1, 3], [0, 1.5], [1, 0]],
    [[1, 3], [0, 4.5], [1, 6], [3, 6], [4, 4.5], [3, 3]],
  ],
  9: [[[4, 3.5], [1, 3.5], [0, 2.5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 4.5], [3, 6], [1, 6]]],
})

const WIDTH = 120
const HEIGHT = 40
/** 网格 → 像素：一格 4px，字符本体 16 × 24 */
const UNIT = 4

/** 随机源一律走 crypto：Math.random 的状态可以被同一进程的其它调用慢慢推出来 */
function randFloat(min, max) {
  return min + (randomInt(0, 1000) / 1000) * (max - min)
}

/**
 * 生成答案。每一位独立取，所以「AAAA」这种也有极低概率出现——
 * 对验证码来说这不是问题，反而说明随机是真的。
 *
 * @param {number} [length]
 * @returns {string}
 */
export function randomText(length = 4) {
  let text = ''
  for (let i = 0; i < length; i += 1) {
    text += CHARSET[randomInt(0, CHARSET.length)]
  }
  return text
}

/** 一条折线 → SVG path 的 d。坐标在这里从网格换算成像素 */
function strokeToPath(points) {
  return points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x * UNIT} ${y * UNIT}`)
    .join(' ')
}

/** 干扰曲线：从左侧随机高度画到右侧，不构成任何字符 */
function noisePath() {
  const y = randFloat(4, HEIGHT - 4)
  return `<path d="M0 ${y.toFixed(1)} C ${randFloat(10, 40).toFixed(1)} ${randFloat(0, HEIGHT).toFixed(1)}, `
    + `${randFloat(70, 110).toFixed(1)} ${randFloat(0, HEIGHT).toFixed(1)}, ${WIDTH} ${randFloat(4, HEIGHT - 4).toFixed(1)}" `
    + `fill="none" stroke="#9aa08f" stroke-width="0.8" opacity="${randFloat(0.25, 0.45).toFixed(2)}"/>`
}

/**
 * 把 4 个字符画成一张 SVG。
 *
 * @param {string} text 答案，长度不设限，但路由只传 4
 * @returns {string}
 */
export function renderSvg(text) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" `
      + `viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="图形验证码">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#fbf9f3"/>`,
  ]

  const noiseCount = randomInt(3, 6)
  for (let i = 0; i < noiseCount; i += 1) parts.push(noisePath())

  // 字符间距**略小于字宽**（23 < 16×1.15），相邻两个字会轻微叠压：
  // 留出空隙等于帮识别脚本把四个字切开，叠一点能显著抬高切分成本，
  // 又不至于让人自己看不清（见 §5.4：真正管用的是一次性 + 短时效）
  const step = 23
  const startX = (WIDTH - (step * (text.length - 1) + 16)) / 2

  ;[...text].forEach((char, index) => {
    const glyph = GLYPHS[char]
    // 字库里没有就跳过：宁可图少一个字符，也不要在图里拼一个「?」把答案暴露出去
    if (!glyph) return

    // 每个字符独立旋转 / 缩放 / 抖动，是这套验证码主要的抗识别手段
    const transform = `translate(${(startX + index * step + randFloat(-2, 2)).toFixed(1)} `
      + `${randFloat(4, 8).toFixed(1)}) scale(${randFloat(0.85, 1.15).toFixed(2)}) `
      + `rotate(${randFloat(-22, 22).toFixed(1)} 8 12)`

    const d = glyph.map(strokeToPath).join(' ')
    const strokeWidth = randFloat(1.4, 2.2).toFixed(2)
    const opacity = randFloat(0.75, 1).toFixed(2)

    parts.push(
      `<path d="${d}" fill="none" stroke="#293d31" stroke-width="${strokeWidth}" `
        + `stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" transform="${transform}"/>`,
    )
  })

  parts.push('</svg>')
  return parts.join('')
}
