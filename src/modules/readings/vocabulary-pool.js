import { daysSince, isSameLocalDay } from '../../shared/utils/time.js'

/**
 * 候选池（方案 §3.1 第 ① 步）。
 *
 * 纯函数，不碰数据库：输入是一批词文档，输出是「这次交给模型用哪些词」。
 * 之所以把它从 generateReading 里拆出来，是因为选池的规则会反复调参
 * （比例、优先级、截断），留在主流程里每改一次都要靠真实生成来验证。
 *
 * 关键认知（方案 §2）：一篇文章只用得到 20–80 个**不同**的个人词，
 * 所以「候选池 35% 还是 70%」是弱旋钮，「从池子里挑哪几十个」才是强旋钮。
 */

/** 各难度取用户词库的比例；数字越大，交给模型的词越多 */
export const POOL_RATIOS = Object.freeze({ easy: 0.35, medium: 0.5, hard: 0.7 })

/** 候选池上限：防止大词库把提示词撑爆，也保住输出 token 预算 */
export const POOL_LIMIT = 800

/** 每 10 个正文词对应 1 个目标词 */
export const TARGET_WORD_RATIO = 0.1

/** 超过这么多天没复习就算「久未复习」，进入最高优先级 */
export const REVIEW_STALE_DAYS = 7

/** 词源选项；'all' 与其它值同时出现时按全选处理 */
export const VOCAB_SCOPES = Object.freeze(['today_new', 'today_reviewed', 'all'])

/**
 * 归一化 scope。
 * - 空数组 / 非法值 → ['all']（契约里空数组是 400，但那属于请求校验，不在这里做）
 * - 含 'all' → 只留 'all'，其它值被忽略
 * - 其余去重
 */
export function normalizeScope(scope) {
  const list = Array.isArray(scope)
    ? scope.filter((item) => VOCAB_SCOPES.includes(item))
    : []

  if (list.length === 0 || list.includes('all')) return ['all']

  return [...new Set(list)]
}

/** 按篇幅算出的目标词数：100→10、300→30、800→80 */
export function requiredTargetWords(targetWords) {
  return Math.round(Number(targetWords) * TARGET_WORD_RATIO)
}

/**
 * 按难度折算出的「至少需要多少个已学词」。
 *
 *   neededVocab = ceil(requiredWords ÷ ratio(level))
 *
 * 困难模式 800 词 → 80 ÷ 0.7 ≈ 115。用户词数少于这个值时，
 * 池子怎么截都凑不出足够的目标词，必须提前 422 而不是白调一次 AI。
 */
export function neededVocabulary({ targetWords, level }) {
  const ratio = POOL_RATIOS[level] ?? POOL_RATIOS.medium

  return Math.ceil(requiredTargetWords(targetWords) / ratio)
}

/**
 * 复习优先级：数字越小越优先。
 *
 *   P1 久未复习（从未复习，或超过 REVIEW_STALE_DAYS 天没复习）
 *   P2 常规
 *   P3 已掌握
 *
 * 已掌握优先看 status 而不是时间：用户手动标成 mastered 的词，
 * 就算最近没复习也说明了熟练度，不该挤占新词的复现机会。
 */
export function priorityOf(word, now = new Date()) {
  if (word.status === 'mastered') return 3
  if (daysSince(word.lastReviewedAt, now) >= REVIEW_STALE_DAYS) return 1

  return 2
}

/**
 * 取难度序。
 * 查不到排名的词（手填、an / yourselves）按「最简单」处理：
 * 它们的真实难度未知，但通常是最基础的功能词，放进 easy 端更安全。
 */
function rankKey(word) {
  return Number.isInteger(word.cocaRank) ? word.cocaRank : 0
}

/** 组内按难度排序：easy 由易到难，hard 由难到易；同难度按词形兜底保证稳定 */
function compareByLevel(a, b, level) {
  const left = rankKey(a)
  const right = rankKey(b)

  if (left !== right) {
    return level === 'hard' ? right - left : left - right
  }

  return String(a.word).localeCompare(String(b.word))
}

/** 先按优先级分组，组内再按难度排序 */
export function sortCandidates(words, level, now = new Date()) {
  return [...words].sort((a, b) => {
    const diff = priorityOf(a, now) - priorityOf(b, now)

    return diff !== 0 ? diff : compareByLevel(a, b, level)
  })
}

/**
 * 按词源过滤。多个来源取并集；'all' 直接返回全量。
 *
 * 「今天复习」依赖 lastReviewedAt，而这个字段只在**提交练习**时回写，
 * 所以刚生成、还没答题时它一定是空的——这是有意为之（方案 §4.1）。
 */
export function filterByScope(words, scope, now = new Date()) {
  const normalized = normalizeScope(scope)
  if (normalized.includes('all')) return [...words]

  return words.filter((word) => {
    if (normalized.includes('today_new') && isSameLocalDay(word.createdAt, now)) {
      return true
    }

    if (
      normalized.includes('today_reviewed') &&
      isSameLocalDay(word.lastReviewedAt, now)
    ) {
      return true
    }

    return false
  })
}

/**
 * 选池主入口。
 *
 * @param {{
 *   words: Array<{ word: string, status: string, cocaRank?: number|null,
 *                  lastReviewedAt?: Date|null, createdAt?: Date }>,
 *   level: 'easy'|'medium'|'hard',
 *   scope?: string[],
 *   targetWords: number,
 *   now?: Date,
 *   limit?: number,
 * }} params
 * @returns {{
 *   pool: string[], poolSize: number, available: number,
 *   requiredWords: number, neededVocab: number,
 *   sufficient: boolean, scope: string[],
 * }}
 *
 * `sufficient` 为 false 时由调用方抛 422 VOCABULARY_TOO_SMALL——
 * 这个模块只负责判断和给数字，不认识 HTTP 状态码。
 */
export function selectVocabularyPool({
  words,
  level,
  scope = ['all'],
  targetWords,
  now = new Date(),
  limit = POOL_LIMIT,
  // md/54：用户显式选中的词。它们已经占用目标词名额，只剩「剩余配额」需要池子补
  preselected = [],
}) {
  const normalizedScope = normalizeScope(scope)
  const candidates = filterByScope(words, normalizedScope, now)
  const available = candidates.length

  const requiredWords = requiredTargetWords(targetWords)
  const ratio = POOL_RATIOS[level] ?? POOL_RATIOS.medium

  const selected = [
    ...new Set(
      (Array.isArray(preselected) ? preselected : []).map((word) =>
        String(word).toLowerCase(),
      ),
    ),
  ]
  const candidateSet = new Set(candidates.map((word) => word.word))
  // 选中的词即使不在本次 scope 里也照常可用：scope 约束自动挑词的范围，
  // 不约束用户亲手点的词。只有「scope 外」的那部分才是额外 supply。
  const outOfScopeSelected = selected.filter((word) => !candidateSet.has(word)).length
  const remainingRequired = Math.max(0, requiredWords - selected.length)
  // selected 已经分配为目标词，不能再拿去充当补词 supply；
  // 没有选词时 supply === available，neededVocab 与旧实现完全一致
  const supply = Math.max(0, available + outOfScopeSelected - selected.length)
  const neededVocab = Math.ceil(remainingRequired / ratio)

  // 取「比例折算值」与「目标词数」的较大者：四舍五入可能让 available×ratio
  // 比 requiredWords 少一个，导致池子装不下计划里的目标词
  const poolSize = Math.min(
    limit,
    Math.max(requiredWords, Math.ceil(available * ratio)),
  )

  const pool = sortCandidates(candidates, level, now)
    .slice(0, poolSize)
    .map((word) => word.word)

  return {
    pool,
    poolSize: pool.length,
    available,
    requiredWords,
    neededVocab,
    sufficient: supply >= neededVocab,
    scope: normalizedScope,
    // 给诊断与 422 文案用：选了几个、还需自动补几个、实际可补的词数
    selectedCount: selected.length,
    remainingRequired,
    supply,
  }
}
