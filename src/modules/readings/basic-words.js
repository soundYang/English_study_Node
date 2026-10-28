import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FILE = join(ROOT, 'data/basic-words.json')

/**
 * 基础词白名单（当前 2578 词）。
 *
 * 两部分组成：
 *   · 人工筛选的 600 词（功能词 179 + 高频实词 421），见 md/04_基础词库_600词候选清单.md
 *   · 按 COCA 排名补到 rank ≤ 3000 的 1978 词，由 scripts/extend-basic-words.mjs 追加（§4.2）
 *
 * 补齐到 3000 是为了和 `missing_common` 的判定线（COMMON_WORD_RANK）对齐：
 * 判定说「这是常用词」，放行表就不该不认它。
 *
 * 文件不存在时返回空数组而不是抛错：少了这些词只影响生成质量，
 * 不应该让服务起不来。
 */
function loadBasicWords() {
  if (!existsSync(FILE)) return []

  try {
    const list = JSON.parse(readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list.filter((word) => typeof word === 'string') : []
  } catch {
    return []
  }
}

export const basicWords = Object.freeze(loadBasicWords())
