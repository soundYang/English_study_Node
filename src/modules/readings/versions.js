import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * 生成快照：词表版本 + 代码版本 + 模型名。
 *
 * 为什么一定要记：不记版本号，前后两次采样之间 `data/basic-words.json` 可能已经
 * 被换掉、`irregular-forms.json` 可能已经补过条目，两组数字放在一起对比就是错的，
 * 而且从数据本身看不出来——这正是"改了词表所以成功率变好了"这类结论最容易出错的地方。
 *
 * 两个版本号都在模块加载时算一次，之后只读：
 *   · 词表版本是文件内容的短 hash，文件改了它必然变
 *   · 代码版本取 git 提交号，读不到就写 'unknown'，绝不因为读不到就让服务起不来
 */

/** 文件内容 → 8 位短 hash。文件缺失或读不动时返回可辨认的占位值，不抛错 */
function hashFile(file) {
  if (!existsSync(file)) return 'missing'

  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 8)
  } catch {
    return 'unreadable'
  }
}

/**
 * 当前提交号。
 *
 * 用 `git rev-parse` 而不是读 `.git/HEAD`：worktree、submodule、packed-refs 三种情况
 * 下文件格式都不一样，自己解析迟早出错。子进程贵在毫秒级、且一个进程只跑一次。
 */
function readCodeVersion() {
  try {
    const output = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()

    return output || 'unknown'
  } catch {
    // 没装 git、在压缩包里跑、或者不是 git 仓库：都只影响可追溯性，不影响生成
    return 'unknown'
  }
}

export const basicWordsVersion = hashFile(join(ROOT, 'data/basic-words.json'))
/**
 * 不规则变形表的版本号。
 *
 * 它和基础词表一样会改变「哪些词算表外」：补一条 went→go，
 * 同一篇文章从 1 个违规变成 0 个。不记版本号时，两组采样数字并排看
 * 根本看不出差异来自词表还是模型。
 */
export const irregularFormsVersion = hashFile(join(ROOT, 'data/irregular-forms.json'))
export const codeVersion = readCodeVersion()
