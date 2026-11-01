/**
 * 篇幅 ↔ 词汇量对照表（md/30 §7.1）。
 *
 * 取代旧的 B 门（easy 1000 / medium 1900 / hard 3778）。旧门槛没有能力依据：
 * 实测 200 词只要 647 个已知词、600 词只要 704 个，而旧表要求 3778 个（高 5.2 倍）。
 *
 * 三个概念必须分清（混用是这张表最容易出错的地方）：
 *
 *   personalWords  个人词库里状态为 learning / mastered 的词数       ← 解锁最终模式看这个
 *   knownWords     个人词 ∪ 基础词表 ∪ 日历词 的并集大小（≥ 618）    ← 篇幅门槛看这个
 *   minKnown(N)    写 N 词需要的最低 knownWords                      ← 本模块的核心产出
 *
 * 两者差一个 618（600 个基础词 ∪ 19 个日历词 − 1 个重合的 may）。
 * **不要把 618 写成常量**——它随词表版本变，这里从实际词表现算。
 *
 * 纯函数、不碰数据库：生成与 /capacity 读同一份，预检说能、点下去 422 的分叉不会再有。
 */

import { getPersonalBasicWords } from './basic-words.js'
import { calendarWords } from './calendar-words.js'
import { LEVEL_LIMITS } from './level-limits.js'
import { neededVocabulary } from './vocabulary-pool.js'

/** 解锁最终模式所需的个人词库规模（md/30 §2.2，2026-10-28 用户拍板） */
export const FINAL_MODE_PERSONAL_WORDS = 3000

/** 最终模式的篇幅封顶 */
export const FINAL_MODE_MAX_WORDS = 1000

/** /capacity 的篇幅阶梯步长 */
export const LENGTH_STEP = 100

/**
 * 冷启动篇幅上限（md/39，2026-10-29 产品决定）。
 *
 * 个人词库为零（或凑不齐目标词）时，允许直接用基础词表写 100 / 200 词的文章：
 * 基础词本来就是「这个用户会的基础词」，不违背「用你会过的词写」这条承诺。
 * 300 词以上仍然要求个人词库——那已经不是「第一次试用」，而是要承担复习作用的阅读。
 */
export const COLD_START_MAX_TARGET_WORDS = 200

const DEFAULT_LEVEL = 'easy'
const HARD = 'hard'

/**
 * 实测下限（md/27 §4.6–§4.8 + md/30 §5）：
 * 「这个 knownWords 下，同一参数跑 3 次能有 ≥ 2 次落在 ±15% 内」。
 *
 * 只有 hard 有实测值——三档共用同一份基础词表之后，hard 的候选池最大、最容易成立，
 * 其余两档按 A 门公式折算（更严），不需要单独采样。
 *
 * 100 这一行是 638 而不是 A 门的 633：全局下限 `VOCABULARY_THRESHOLD = 20`
 * 比 100 词的 A 门（15 个个人词）更高，15 词的样本连模型都调不到（md/30 §8.1）。
 */
const MEASURED_MIN_KNOWN = Object.freeze({
  [HARD]: Object.freeze({ 100: 638, 200: 647, 300: 661, 400: 676, 500: 690, 600: 704 }),
})

/**
 * knownWords 的地板：基础词表 ∪ 日历词（个人词库为空时的并集大小）。
 * 现算而不是写 618，词表改版时这里自动跟着变。
 */
const KNOWN_FLOOR = new Map(
  Object.keys(LEVEL_LIMITS).map((level) => [
    level,
    new Set([...getPersonalBasicWords(level, []), ...calendarWords]).size,
  ]),
)

/** 该档的 knownWords 地板（等于「一个人词都没背」时的已知词数） */
export function knownFloorFor(level = HARD) {
  return KNOWN_FLOOR.get(level) ?? KNOWN_FLOOR.get(DEFAULT_LEVEL)
}

/**
 * **某个用户自己的**地板：他的基础词表（已扣掉标了「不认识」的词）∪ 日历词。
 *
 * 与 `knownFloorFor` 的区别就是「扣没扣排除词」。冷启动门槛必须用这一个：
 * `knownWords` 本身就是按用户扣过的，拿全量地板去比，等于要求
 * 「你排除掉的那 N 个词也要认识」——标一个「不认识」，门槛反而更远，永远差 N 个。
 *
 * 传入 `personalBasicWords`（`measureKnownVocabulary` 的产出）时现算；
 * 没传就退回全量地板，老脚本不受影响。
 */
function coldStartFloor(level, personalBasicWords) {
  if (!Array.isArray(personalBasicWords)) return knownFloorFor(level)

  return new Set([...personalBasicWords, ...calendarWords]).size
}

/** 该档的常规篇幅上限（不含最终模式） */
export function baseMaxWordsFor(level = HARD) {
  const limit = LEVEL_LIMITS[level] ?? LEVEL_LIMITS[DEFAULT_LEVEL]

  return limit.maxTargetWords
}

/** 个人词库够不够解锁最终模式（只看 personalWords，不看 knownWords） */
export function isFinalModeUnlocked({ personalWords }) {
  return Number(personalWords) >= FINAL_MODE_PERSONAL_WORDS
}

/**
 * 是不是一次最终模式请求：hard + 超过常规上限 + 已解锁。
 * 三个条件缺一不可——「超过 600 但没解锁」是 400，不是最终模式。
 */
export function isFinalMode({ level, targetWords, personalWords }) {
  return (
    level === HARD
    && Number(targetWords) > baseMaxWordsFor(HARD)
    && isFinalModeUnlocked({ personalWords })
  )
}

/**
 * 该档、该用户实际能用到的篇幅上限。
 * hard 在个人词库 ≥ 3000 时抬到 1000，其余情况仍是 300 / 450 / 600。
 */
export function maxTargetWordsFor(level = HARD, personalWords = 0) {
  const base = baseMaxWordsFor(level)

  if (level !== HARD) return base
  if (Number(personalWords) >= FINAL_MODE_PERSONAL_WORDS) return FINAL_MODE_MAX_WORDS

  return base
}

/** 实测点里「不超过 n 的最大那一档」；n 比最小实测点还小时用最小实测点 */
function measuredFloorFor(targetWords, level) {
  const table = MEASURED_MIN_KNOWN[level]
  if (!table) return 0

  const keys = Object.keys(table).map(Number).sort((left, right) => left - right)
  let picked = keys[0]
  for (const key of keys) {
    if (key <= targetWords) picked = key
  }

  return table[picked]
}

/**
 * 冷启动判定（md/39）：篇幅 ≤ 200 且个人词库凑不齐这次的目标词。
 *
 * 这里只看个人词库条数，不看 scope 过滤后的候选池：scope 是「这次想复习哪批词」，
 * 不是「用户会不会」。今天没有新词就要求降到冷启动门槛，等于让复习节奏左右生成资格。
 *
 * @param {{ level?: string, targetWords: number, personalWords?: number }} params
 */
export function isColdStart({ level = HARD, targetWords, personalWords = 0 }) {
  const n = Math.max(1, Math.round(Number(targetWords) || 0))

  if (n > COLD_START_MAX_TARGET_WORDS) return false

  return Number(personalWords) < neededVocabulary({ targetWords: n, level })
}

/**
 * 写 `targetWords` 词的文章至少要认识多少词。
 *
 *   minKnown(N) = max(实测下限, 618 + A 门折算)
 *
 * A 门是硬地板：候选池都凑不齐目标词时，写得更长只会更糟。
 * 两项都随 N 单调不减，取 max 之后整张表也单调不减。
 *
 * **冷启动例外（md/39）**：`targetWords ≤ 200` 且个人词库凑不齐目标词时，
 * 门槛退回**该用户自己的**地板「他的基础词表 ∪ 日历词」（md/56 §18）——
 * 0 词用户也能写 100 / 200 词。
 * 调用方要把 `personalWords` 与 `personalBasicWords` 传进来；不传（老脚本）则维持原口径。
 *
 * 为什么不能用全量地板：`knownWords` 是按用户排除过的词算的，全量地板没有扣，
 * 用户每标一个「不认识」，门槛就离他远一分——标 3 个，就永远差 3 个。
 *
 * 超过常规上限（601–1000）分两种：
 *   · hard → 折算值 618 + 3000 = 3618。最终模式的真实闸门是 personalWords，
 *     这里给 knownWords 口径只是为了让 /capacity 能用一个字段表达「还差多少」；
 *   · easy / medium → 按**本档上限**算（300 / 450）。这两档根本写不到 601+，
 *     报 3618 只会让人以为「攒够 3000 词就能用 easy 写 1000 词」。
 *
 * 写代码时不要把这个 3618 当常量用：生成链路在最终模式把 minKnown 直接置 0。
 */
export function minKnownFor(
  targetWords,
  level = HARD,
  { personalWords = Number.POSITIVE_INFINITY, personalBasicWords = null } = {},
) {
  const n = Math.max(1, Math.round(Number(targetWords) || 0))

  if (n > baseMaxWordsFor(HARD)) {
    if (level !== HARD) {
      return minKnownFor(baseMaxWordsFor(level), level, { personalWords, personalBasicWords })
    }

    return knownFloorFor(level) + FINAL_MODE_PERSONAL_WORDS
  }

  // 冷启动只放开 100 / 200：基础词表够写这么长，但没有个人词就没有复习对象。
  // 地板按用户自己的算——他排除掉的「不认识」词，不能再算进门槛
  if (isColdStart({ level, targetWords: n, personalWords })) {
    return coldStartFloor(level, personalBasicWords)
  }

  const byGate = knownFloorFor(level) + neededVocabulary({ targetWords: n, level })

  return Math.max(measuredFloorFor(n, level), byGate)
}

/**
 * /capacity 的篇幅阶梯：100 / 200 / … / 1000，每行给出「这一档要多少词、你有没有」。
 *
 * `blockedBy` 是给前端直接用的：同一个 `unlocked: false`，用户要做的事完全不同。
 *   level_cap   这个难度到头了，再往上只能换难度         → 灰掉，不提示加词
 *   final_mode  个人词库没到 3000，攒够才解锁             → 显示「还差 N 个」
 *   known_words 词够解锁但不够写这么长                   → 显示「还差 N 个」
 *   null        可以写
 *
 * 阶梯是**按难度**算的：easy 的第 400 行永远是 level_cap，因为 1000 词只对 hard 开放。
 * 所以 /capacity 把它挂在 `levels[level].lengths` 下，而不是顶层共用一份
 * （md/30 §7.5 的偏离记录）。
 *
 * @param {{
 *   level: string, knownWords: number, personalWords: number,
 *   personalBasicWords?: string[]|null,
 * }} params
 * @returns {Array<{
 *   targetWords: number, minKnown: number, unlocked: boolean,
 *   blockedBy: null|'level_cap'|'final_mode'|'known_words',
 *   shortage: number, finalMode: boolean,
 * }>}
 */
export function lengthLadder({
  level = HARD,
  knownWords = 0,
  personalWords = 0,
  personalBasicWords = null,
}) {
  const finalModeUnlocked = isFinalModeUnlocked({ personalWords })
  const levelCap = maxTargetWordsFor(level, personalWords)
  const ladder = []

  for (let targetWords = LENGTH_STEP; targetWords <= FINAL_MODE_MAX_WORDS; targetWords += LENGTH_STEP) {
    const minKnown = minKnownFor(targetWords, level, { personalWords, personalBasicWords })
    const knownOk = Number(knownWords) >= minKnown
    // 超过本档上限的两种原因要分开报：hard 601+ 是「没解锁」，easy 301+ 是「档位到头」
    const beyondFinalMode = level === HARD && targetWords > baseMaxWordsFor(HARD)

    let blockedBy = null
    if (targetWords > levelCap) blockedBy = beyondFinalMode && !finalModeUnlocked ? 'final_mode' : 'level_cap'
    else if (!knownOk) blockedBy = 'known_words'

    const shortage = blockedBy === 'final_mode'
      ? Math.max(0, FINAL_MODE_PERSONAL_WORDS - personalWords)
      : blockedBy === 'known_words'
        ? Math.max(0, minKnown - knownWords)
        : 0

    ladder.push({
      targetWords,
      minKnown,
      unlocked: blockedBy === null,
      blockedBy,
      shortage,
      finalMode: targetWords > baseMaxWordsFor(HARD),
    })
  }

  return ladder
}
