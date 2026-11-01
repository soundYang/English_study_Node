import { ApiError, ERROR_CODES } from '../../shared/errors.js'
import { WORD_STATUSES } from './word.schema.js'
import { canonicalWord } from '../../shared/utils/word-form.js'
import { findEntry } from '../dictionary/dictionary.loader.js'
import { getWordRank } from './word-ranks.js'

/**
 * 添加单词的纯函数层（md/44 §5）。
 *
 * 这里**不碰数据库**：词库查询是进程内 Map，排名表也是模块级常量。
 * 单条创建、批量导入、提交前预检三条路径共用同一套规则，
 * 差别只在「谁来查已有记录、谁来写库」。
 */

export const DEFAULT_WORD_STATUS = 'learning'

/** 重复词合并动作，数值只用于「一次请求回一个动作」时的优先级排序 */
export const DUPLICATE_ACTIONS = Object.freeze({
  kept: 0,
  enriched: 1,
  updated: 2,
  reactivated: 3,
})

/** 批量导入允许的重复处理策略 */
export const DUPLICATE_POLICIES = Object.freeze(['auto', 'skip', 'error'])

/** status 非法回落 learning，不报错（契约 md/05 §3.2 第 7 条） */
export function normalizeStatus(raw, fallback = DEFAULT_WORD_STATUS) {
  return WORD_STATUSES.includes(raw) ? raw : fallback
}

/**
 * 只升不降：一次合并可能同时触发「改状态」和「补快照」，
 * 对外只能报一个动作，按 reactivated > updated > enriched > kept 取最高的。
 */
function raiseAction(current, next) {
  return DUPLICATE_ACTIONS[next] > DUPLICATE_ACTIONS[current] ? next : current
}

/** 义项比较用的归一化：去掉空白与常见分隔符，只留文字本身 */
const SENSE_SEPARATOR_PATTERN = /[\s；;，,、。．./|（）()\[\]【】]/g

function normalizeSenseText(text) {
  return String(text ?? '').replace(SENSE_SEPARATOR_PATTERN, '').toLowerCase()
}

/**
 * 用户释义是否已被词库义项覆盖。
 *
 * 「放弃」被「放弃，抛弃；离弃，丢弃…」包含，视为已覆盖——
 * 词库的说法更完整，没必要再存一条更短的。
 */
export function isCoveredByEntry(entry, meaning) {
  const target = normalizeSenseText(meaning)
  if (!target) return true
  return entry.senses.some((sense) => normalizeSenseText(sense.meaning).includes(target))
}

/**
 * 词库义项 + 手填释义 → 落库 `senses`（md/51）。
 *
 * 词库义项全部保留、排在前面：列表第一行要能显示词性，
 * 手填释义的 `pos` 只能是空串，不能占第一条。
 * 用户释义没被词库覆盖时追加到最后一条，**永远不丢**。
 */
export function mergeSenses(entry, meaning = '') {
  const senses = entry.senses.map((sense) => ({
    pos: sense.pos ?? '',
    meaning: sense.meaning,
  }))

  if (!meaning || isCoveredByEntry(entry, meaning)) return senses

  return [...senses, { pos: '', meaning }]
}

/** 词库词条 → 落库快照的公共部分 */
function snapshotFromEntry(entry, meaning = '') {
  return {
    dictionaryId: entry.id ?? null,
    phonetic: {
      uk: entry.phonetic?.uk ?? null,
      us: entry.phonetic?.us ?? null,
    },
    senses: mergeSenses(entry, meaning),
  }
}

/**
 * 组装新建文档。
 *
 * 词库补全规则（md/51，替代 md/44 §5.2 的「释义为空才补」）：
 *   1. 显式 `source='dictionary'` → 必须命中词库，否则 400
 *   2. 手填 + 词库命中         → 一律带词库快照（音标 / 词性 / 完整义项），
 *                                用户释义按 `mergeSenses` 合并进来
 *   3. 手填 + 词库没有         → 存 manual（有释义就一条无词性义项）
 *
 * `source` 的含义不变：这条记录的释义是用户给的（`manual`，可继续编辑）
 * 还是服务端从词库拿的（`dictionary`，释义只读）。命中词库但用户带了释义时，
 * 落 `manual` —— 用户仍可以改自己的释义，词库快照只是补全，不是接管。
 *
 * @param {{ userId: string, word: string, status?: string, source?: string, meaning?: string }} input
 * @returns {object} 可直接交给 Word.create 的字段
 */
export function buildCreatePayload({ userId, word, status, source, meaning = '' }) {
  const nextStatus = normalizeStatus(status)

  if (source === 'dictionary') {
    const entry = findEntry(word)

    if (!entry?.senses?.length) {
      throw new ApiError(
        400,
        ERROR_CODES.DICTIONARY_ENTRY_NOT_FOUND,
        '词库中没有这个单词',
      )
    }

    return {
      userId,
      word,
      status: nextStatus,
      source: 'dictionary',
      ...snapshotFromEntry(entry),
      cocaRank: getWordRank(word),
    }
  }

  const entry = findEntry(word)

  if (entry?.senses?.length) {
    return {
      userId,
      word,
      status: nextStatus,
      // 带了释义说明用户要的是自己的说法，保持可编辑；没带才是纯词库词
      source: meaning ? 'manual' : 'dictionary',
      ...snapshotFromEntry(entry, meaning),
      cocaRank: getWordRank(word),
    }
  }

  return {
    userId,
    word,
    status: nextStatus,
    source: 'manual',
    dictionaryId: null,
    phonetic: null,
    senses: meaning ? [{ pos: '', meaning }] : [],
    cocaRank: getWordRank(word),
  }
}

/**
 * 重复词的合并判定（md/44 §5.3）。
 *
 * 四条不变量，测试里逐条断言：
 *   1. 永不覆盖非空的手填释义；
 *   2. 永不重置学习进度（createdAt / lastReviewedAt / articleExposureCount / cocaRank）；
 *   3. 只有 manual 空释义或 basic-removed 占位词会被补快照；
 *   4. 一次只回一个 action（reactivated > updated > enriched > kept）。
 *
 * @param {object} existing Word 文档（lean 或 Mongoose 文档均可）
 * @param {{ status?: string, meaning?: string }} request
 * @returns {{ action: 'kept'|'enriched'|'updated'|'reactivated', update: object|null }}
 */
export function resolveDuplicate(existing, { status, meaning = '' } = {}) {
  const nextStatus = normalizeStatus(status)
  const update = {}
  let action = 'kept'

  if (existing.status !== nextStatus) {
    update.status = nextStatus
    // 「转正」只对墓碑成立，由下面的 basic-removed 分支改写 action；
    // 普通状态互转（含 new → learning）只是更新（md/56 §18）
    action = 'updated'
  }

  const senses = existing.senses ?? []
  const hasSenses = senses.length > 0
  const entry = findEntry(existing.word)
  const dictionaryHasEntry = Boolean(entry?.senses?.length)

  if (existing.source === 'basic-removed') {
    // 占位词转正：source 必须离开 basic-removed，否则基础词页仍然显示「不认识」。
    // 已有快照（移除时写进去的）保留；没有才补
    if (update.status && update.status !== 'new') {
      update.source = dictionaryHasEntry ? 'dictionary' : 'manual'
      if (!hasSenses && dictionaryHasEntry) {
        Object.assign(update, snapshotFromEntry(entry))
      }
      action = 'reactivated'
    }
  } else if (existing.source === 'manual' && !hasSenses) {
    // 手填空释义：词库命中就一律带快照（md/51）。这次带了释义时与词库义项合并，
    // 不再只存一条无词性释义；没带释义时仍是纯词库词。
    // 只能往上升级：这次同时改了状态时，action 仍是 updated / reactivated
    if (dictionaryHasEntry) {
      if (!meaning) update.source = 'dictionary'
      Object.assign(update, snapshotFromEntry(entry, meaning))
      action = raiseAction(action, 'enriched')
    } else if (meaning) {
      update.senses = [{ pos: '', meaning }]
      action = raiseAction(action, 'enriched')
    }
  }

  if (!Object.keys(update).length) return { action: 'kept', update: null }

  return { action, update }
}

/** 释义前缀：CJK 统一表意文字（含扩展 A）与兼容表意文字 */
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * 解析粘贴文本（md/44 §5.4）。
 *
 * 每行一条，支持三种写法：
 *   abandon<TAB>放弃，抛弃
 *   abandon - 放弃，抛弃        （短横线 / 冒号 / 等号，两侧要有空格）
 *   abandon 放弃，抛弃          （第一个中文字符处切开）
 *   abandon                     （没有释义，交给词库补全）
 *
 * `#` / `//` 开头的行当注释，空行跳过。
 * 返回的 `index` 是行号（0 基），只用于把错误指回原输入。
 *
 * @param {string} text
 * @returns {Array<{ index: number, raw: string, word: string, meaning: string }>}
 */
export function parseWordText(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)

  const entries = []

  lines.forEach((rawLine, index) => {
    const raw = rawLine.trim()

    if (!raw || raw.startsWith('#') || raw.startsWith('//')) return

    entries.push({ index, raw, ...splitLine(raw) })
  })

  return entries
}

/** 一行的切分规则；顺序不能反：先找显式分隔符，再找中文字符 */
function splitLine(raw) {
  const tabbed = raw.match(/^(.*?)[\t　](.*)$/)
  if (tabbed) {
    return { word: canonicalWord(tabbed[1]), meaning: tabbed[2].trim() }
  }

  // 两侧带空格的短横线 / 冒号 / 等号。要求两侧空格是为了不误伤 well-known
  const dashed = raw.match(/^(.*?)\s[-–—:=]\s(.*)$/)
  if (dashed) {
    return { word: canonicalWord(dashed[1]), meaning: dashed[2].trim() }
  }

  const cjk = raw.search(CJK_PATTERN)
  if (cjk >= 0) {
    return { word: canonicalWord(raw.slice(0, cjk)), meaning: raw.slice(cjk).trim() }
  }

  return { word: canonicalWord(raw), meaning: '' }
}
