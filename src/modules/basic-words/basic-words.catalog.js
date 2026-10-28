import { ABBREVIATIONS } from '../readings/abbreviations.js'
import { getBasicWords, functionWords } from '../readings/basic-words.js'
import { calendarWords } from '../readings/calendar-words.js'

/**
 * 基础词页面的单词目录（md/29）。
 *
 * 页面要同时展示三张白名单，但它们来源不同、能不能改也不同：
 *
 * | 组 | 数量 | 来源 | 可改 |
 * | --- | --- | --- | --- |
 * | basic | 600 | data/basic-words.easy.json | 只有 421 个实词 |
 * | calendar | 19 | calendar-words.js | 否 |
 * | abbreviation | 32 | abbreviations.js | 否 |
 *
 * 三张表唯一的重合是 `may`（情态动词 + 五月）。它只在基础词组出现一次，
 * 但 `kinds` 里同时记上 calendar——这样按组筛选「日历词」时它仍然在结果里，
 * 不会出现「日历词说有 19 个，列表只翻到 18 个」的对不上。
 *
 * 目录在进程内构建一次，纯只读，和 dictionary.loader 同一套思路。
 */

const WEEKDAYS = new Set(calendarWords.slice(0, 7))

/** @typedef {'basic'|'calendar'|'abbreviation'} BasicWordKind */

function buildCatalog() {
  const functionWordSet = new Set(functionWords)
  const basic = getBasicWords()
  const entries = []
  const byWord = new Map()

  const push = (entry) => {
    entries.push(entry)
    byWord.set(entry.word, entry)
  }

  for (const word of basic) {
    push({
      word,
      kinds: ['basic'],
      // 只有非功能词的实词可以移除。179 个功能词缺一个句子就写不出来
      removable: !functionWordSet.has(word),
      isFunctionWord: functionWordSet.has(word),
      calendarType: null,
      expansion: null,
      expansionMeaning: null,
    })
  }

  for (const word of calendarWords) {
    // may 已经在基础词里（情态动词），只补一个 kind，不重复成两条
    const existing = byWord.get(word)
    if (existing) {
      existing.kinds.push('calendar')
      existing.calendarType = WEEKDAYS.has(word) ? 'weekday' : 'month'
      continue
    }

    push({
      word,
      kinds: ['calendar'],
      removable: false,
      isFunctionWord: false,
      calendarType: WEEKDAYS.has(word) ? 'weekday' : 'month',
      expansion: null,
      expansionMeaning: null,
    })
  }

  for (const [word, info] of Object.entries(ABBREVIATIONS)) {
    push({
      word,
      kinds: ['abbreviation'],
      removable: false,
      isFunctionWord: false,
      calendarType: null,
      // expansion 就是「由哪几个单词组成」——dr → doctor、usa → United States of America
      expansion: info.expansion,
      expansionMeaning: info.meaning,
    })
  }

  // 字母序：浏览页是「从 a 翻到 z」，不是按 COCA 排名也不是按文件顺序。
  // 排序放在这里而不是每次请求时做，是因为它和数据本身一样不会变。
  entries.sort((left, right) => left.word.localeCompare(right.word))

  return Object.freeze(entries)
}

export const basicWordCatalog = buildCatalog()

export const basicWordByWord = new Map(basicWordCatalog.map((entry) => [entry.word, entry]))

/** 三组的固定顺序；筛选和排序都以它为准 */
export const BASIC_WORD_GROUPS = Object.freeze(['all', 'basic', 'calendar', 'abbreviation'])

/** 状态筛选；unknown = 没有记录或标记为不认识 */
export const BASIC_WORD_STATUS_FILTERS = Object.freeze(['all', 'known', 'unknown', 'removed'])
