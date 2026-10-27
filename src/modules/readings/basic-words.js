import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FILE = join(ROOT, 'data/basic-words.json')

/**
 * COCA 词频前 800 的基础词白名单，由 scripts/build-basic-words.mjs 生成（S7）。
 *
 * 文件不存在时返回空数组而不是抛错：S6 阶段还没生成它，
 * 少了这些词只影响生成质量，不应该让服务起不来。
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
