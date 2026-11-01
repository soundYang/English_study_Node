import { describe, expect, it } from 'vitest'

import {
  FINAL_MODE_MAX_WORDS,
  FINAL_MODE_PERSONAL_WORDS,
  LENGTH_STEP,
  baseMaxWordsFor,
  isFinalMode,
  isFinalModeUnlocked,
  knownFloorFor,
  lengthLadder,
  maxTargetWordsFor,
  minKnownFor,
} from '../modules/readings/capacity-table.js'
import { basicWordsByLevel, functionWords } from '../modules/readings/basic-words.js'
import { calendarWords } from '../modules/readings/calendar-words.js'
import { measureKnownVocabulary } from '../modules/readings/level-limits.js'

/**
 * 篇幅 ↔ 词汇量对照表（md/30 §7.1、§8.2）。
 *
 * 这张表取代了旧 B 门（easy 1000 / medium 1900 / hard 3778）。测试要守的是：
 *   · 实测点原样落表（它们是真实采样结果，不是拍脑袋写的）；
 *   · 整张表**单调不减**——否则「用户加词反而失去能力」，预检也会自相矛盾；
 *   · 三个概念（personalWords / knownWords / minKnown）不会被混用。
 */

/** 基础词（600）∪ 日历词的去重大小 —— knownWords 在个人词库为空时的取值 */
const KNOWN_FLOOR = 618

describe('knownFloorFor', () => {
  it('等于「一个人词都没背」时的已知词数：600 基础 ∪ 19 日历 − 1 重合', () => {
    for (const level of ['easy', 'medium', 'hard']) {
      expect(knownFloorFor(level)).toBe(KNOWN_FLOOR)
    }
  })
})

describe('minKnownFor — 实测点', () => {
  it('hard 的六个实测点与 md/30 §5 一致', () => {
    expect(minKnownFor(100, 'hard')).toBe(638)
    expect(minKnownFor(200, 'hard')).toBe(647)
    expect(minKnownFor(300, 'hard')).toBe(661)
    expect(minKnownFor(400, 'hard')).toBe(676)
    expect(minKnownFor(500, 'hard')).toBe(690)
    expect(minKnownFor(600, 'hard')).toBe(704)
  })

  it('100 词取 638 而不是 A 门折算的 633：全局下限 20 让 15 词的样本跑不起来', () => {
    // ceil(10 ÷ 0.7) = 15 → 618 + 15 = 633，但实测下限更高
    expect(minKnownFor(100, 'hard')).toBeGreaterThan(KNOWN_FLOOR + 15)
  })

  it('easy / medium 没有实测表，按 A 门折算（更严）', () => {
    // easy: ceil(10 ÷ 0.35) = 29；medium: ceil(10 ÷ 0.5) = 20
    expect(minKnownFor(100, 'easy')).toBe(KNOWN_FLOOR + 29)
    expect(minKnownFor(100, 'medium')).toBe(KNOWN_FLOOR + 20)
    expect(minKnownFor(600, 'easy')).toBe(KNOWN_FLOOR + Math.ceil(60 / 0.35))
  })
})

describe('minKnownFor — 形状', () => {
  it('100–1000 全区间单调不减', () => {
    let previous = 0

    for (let targetWords = 100; targetWords <= FINAL_MODE_MAX_WORDS; targetWords += 1) {
      const current = minKnownFor(targetWords, 'hard')

      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  it('实测点之间插值取「不超过 N 的最大实测点」，不跳水也不虚高', () => {
    // 250 落在 200–300 之间，取 200 的实测下限 647（A 门折算 651 更高，取 max）
    expect(minKnownFor(250, 'hard')).toBe(Math.max(647, KNOWN_FLOOR + Math.ceil(25 / 0.7)))
  })

  it('hard 超过 600 返回 618 + 3000 = 3618，只为 /capacity 能用一个字段表达差额', () => {
    expect(minKnownFor(700, 'hard')).toBe(KNOWN_FLOOR + FINAL_MODE_PERSONAL_WORDS)
    expect(minKnownFor(1000, 'hard')).toBe(KNOWN_FLOOR + FINAL_MODE_PERSONAL_WORDS)
    // 比常规上限那一档更严，否则阶梯上会出现「601 比 600 还容易」
    expect(minKnownFor(1000, 'hard')).toBeGreaterThan(minKnownFor(600, 'hard'))
  })

  it('easy / medium 写不到 601+，按本档上限算，不报 3618', () => {
    // 否则容易读成「攒够 3000 词就能用 easy 写 1000 词」
    expect(minKnownFor(700, 'easy')).toBe(minKnownFor(300, 'easy'))
    expect(minKnownFor(1000, 'medium')).toBe(minKnownFor(450, 'medium'))
    expect(minKnownFor(700, 'easy')).toBeLessThan(KNOWN_FLOOR + FINAL_MODE_PERSONAL_WORDS)
  })

  it('非法输入不炸：0 / 负数 / NaN 按 1 词处理', () => {
    expect(minKnownFor(0, 'hard')).toBe(minKnownFor(1, 'hard'))
    expect(Number.isFinite(minKnownFor(Number.NaN, 'hard'))).toBe(true)
  })
})

describe('minKnownFor — 冷启动地板按用户自己算（md/56 §18）', () => {
  // 用户把两个基础词标成了「不认识」。挑不在日历词表、也不是功能词的：
  // 删一个日历词，并集只少 1 个（它两边都有）；功能词根本不参与减法
  const calendar = new Set(calendarWords)
  const funcs = new Set(functionWords)
  const removed = basicWordsByLevel.easy
    .filter((word) => !calendar.has(word) && !funcs.has(word))
    .slice(0, 2)
  const personalBasicWords = basicWordsByLevel.easy.filter((word) => !removed.includes(word))
  const ownFloor = new Set([...personalBasicWords, ...calendarWords]).size

  it('地板扣掉用户排除的词，不做全量要求', () => {
    expect(ownFloor).toBe(KNOWN_FLOOR - 2)
    expect(minKnownFor(100, 'easy', { personalWords: 0, personalBasicWords })).toBe(ownFloor)
    expect(minKnownFor(100, 'hard', { personalWords: 0, personalBasicWords })).toBe(ownFloor)
  })

  it('knownWords 恰好等于自己的地板时门槛通过（全量地板下会永远差 2 个）', () => {
    const known = measureKnownVocabulary({
      level: 'easy',
      learnedWords: [],
      removedBasicWords: removed,
    })

    expect(known.knownWords).toBe(ownFloor)
    expect(
      minKnownFor(100, 'easy', {
        personalWords: 0,
        personalBasicWords: known.personalBasicWords,
      }),
    ).toBe(ownFloor)
  })

  it('不传 personalBasicWords 时维持全量地板，老脚本行为不变', () => {
    expect(minKnownFor(100, 'easy', { personalWords: 0 })).toBe(KNOWN_FLOOR)
    expect(minKnownFor(100, 'easy')).toBe(KNOWN_FLOOR + 29)
  })

  it('阶梯里的 100 / 200 也按用户地板解锁', () => {
    const ladder = lengthLadder({
      level: 'easy',
      knownWords: ownFloor,
      personalWords: 0,
      personalBasicWords,
    })

    expect(ladder[0]).toMatchObject({ targetWords: 100, unlocked: true, blockedBy: null })
    expect(ladder[1]).toMatchObject({ targetWords: 200, unlocked: true, blockedBy: null })
  })
})

describe('maxTargetWordsFor', () => {
  it('常规三档：300 / 450 / 600', () => {
    for (const personalWords of [0, 2999]) {
      expect(maxTargetWordsFor('easy', personalWords)).toBe(300)
      expect(maxTargetWordsFor('medium', personalWords)).toBe(450)
      expect(maxTargetWordsFor('hard', personalWords)).toBe(600)
    }
  })

  it('只有 hard 会因个人词库 ≥ 3000 抬到 1000', () => {
    expect(maxTargetWordsFor('hard', 3000)).toBe(FINAL_MODE_MAX_WORDS)
    expect(maxTargetWordsFor('easy', 3000)).toBe(300)
    expect(maxTargetWordsFor('medium', 3000)).toBe(450)
    expect(baseMaxWordsFor('hard')).toBe(600)
  })

  it('未知难度按 easy 处理', () => {
    expect(maxTargetWordsFor('insane', 5000)).toBe(300)
  })
})

describe('isFinalMode — 三个条件缺一不可', () => {
  it('hard + > 600 + 个人词库 ≥ 3000 才是最终模式', () => {
    expect(isFinalMode({ level: 'hard', targetWords: 700, personalWords: 3000 })).toBe(true)
    expect(isFinalMode({ level: 'hard', targetWords: 700, personalWords: 2999 })).toBe(false)
    expect(isFinalMode({ level: 'hard', targetWords: 600, personalWords: 3000 })).toBe(false)
    expect(isFinalMode({ level: 'medium', targetWords: 700, personalWords: 5000 })).toBe(false)
  })

  it('解锁只看 personalWords，不看 knownWords', () => {
    expect(isFinalModeUnlocked({ personalWords: FINAL_MODE_PERSONAL_WORDS })).toBe(true)
    expect(isFinalModeUnlocked({ personalWords: FINAL_MODE_PERSONAL_WORDS - 1 })).toBe(false)
    // 一个词都没背时 knownWords 也有 618，那不等于解锁
    expect(isFinalModeUnlocked({ personalWords: 0 })).toBe(false)
  })
})

describe('lengthLadder', () => {
  it('固定 10 行，步长 100，到 1000 为止', () => {
    const ladder = lengthLadder({ level: 'hard', knownWords: KNOWN_FLOOR, personalWords: 0 })

    expect(ladder).toHaveLength(FINAL_MODE_MAX_WORDS / LENGTH_STEP)
    expect(ladder.map((row) => row.targetWords)).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ])
  })

  it('20 个词、638 个已知词：100/200 可用（200 走冷启动），300+ 仍是 known_words', () => {
    const ladder = lengthLadder({ level: 'hard', knownWords: 638, personalWords: 20 })

    expect(ladder[0]).toMatchObject({ targetWords: 100, unlocked: true, blockedBy: null })
    // md/39：200 词以内凑不齐目标词时退回基础词地板，20 个个人词也能写 200
    expect(ladder[1]).toMatchObject({
      targetWords: 200,
      unlocked: true,
      blockedBy: null,
      minKnown: KNOWN_FLOOR,
    })
    expect(ladder[2]).toMatchObject({ targetWords: 300, blockedBy: 'known_words', shortage: 661 - 638 })
    expect(ladder[5]).toMatchObject({ targetWords: 600, blockedBy: 'known_words' })
    // 601+ 即便词够也先看解锁；这里是词不够 + 没解锁，解锁更根本
    expect(ladder[6]).toMatchObject({
      targetWords: 700,
      blockedBy: 'final_mode',
      shortage: FINAL_MODE_PERSONAL_WORDS - 20,
      finalMode: true,
    })
  })

  it('easy 的 400 是档位到头，不是词不够：blockedBy=level_cap 且不提示差额', () => {
    const ladder = lengthLadder({ level: 'easy', knownWords: 5000, personalWords: 5000 })

    expect(ladder[3]).toMatchObject({
      targetWords: 400,
      unlocked: false,
      blockedBy: 'level_cap',
      shortage: 0,
      finalMode: false,
    })
  })

  it('个人词库 3000 时，整条阶梯全亮（hard）', () => {
    // knownWords = 3000 + 618 = 3618，恰好等于 601+ 的折算门槛
    const ladder = lengthLadder({ level: 'hard', knownWords: 3618, personalWords: 3000 })

    expect(ladder.every((row) => row.unlocked)).toBe(true)
    expect(ladder.every((row) => row.blockedBy === null)).toBe(true)
  })
})
