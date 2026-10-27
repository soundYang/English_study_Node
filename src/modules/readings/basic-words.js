import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FILE = join(ROOT, 'data/basic-words.json')

/**
 * 基础词白名单（当前 600 词：功能词 179 + 高频实词 421）。
 * 清单与筛选规则见 md/基础词库_600词候选清单.md。
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
