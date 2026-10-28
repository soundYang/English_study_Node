/**
 * 常用缩写。
 *
 * 与 calendar-words.js 同构：不进 data/basic-words.json，因为它们是「词的简写」
 * 而不是「词」——前端要单独成组并显示全称，塞进基础词表就只剩一个孤零零的串。
 *
 * 只收语义唯一的：st（saint / street / stone）、no（number / 否定词）、
 * min、sec 这类无法判定的不收——宁可偶尔误判一次生词，也不要给出错误全称。
 */
export const ABBREVIATIONS = Object.freeze({
  dr: { expansion: 'doctor', meaning: '医生；博士' },
  mr: { expansion: 'mister', meaning: '先生' },
  mrs: { expansion: 'missus', meaning: '夫人' },
  ms: { expansion: 'miss', meaning: '女士' },
  jr: { expansion: 'junior', meaning: '小（姓名后缀）' },
  sr: { expansion: 'senior', meaning: '老（姓名后缀）' },
  prof: { expansion: 'professor', meaning: '教授' },
  vs: { expansion: 'versus', meaning: '对；与…相比' },
  etc: { expansion: 'et cetera', meaning: '等等' },
  eg: { expansion: 'for example', meaning: '例如' },
  ie: { expansion: 'that is', meaning: '即；也就是说' },
  am: { expansion: 'ante meridiem', meaning: '上午' },
  pm: { expansion: 'post meridiem', meaning: '下午' },
  usa: { expansion: 'United States of America', meaning: '美国' },
  uk: { expansion: 'United Kingdom', meaning: '英国' },
  un: { expansion: 'United Nations', meaning: '联合国' },
  eu: { expansion: 'European Union', meaning: '欧盟' },
  tv: { expansion: 'television', meaning: '电视' },
  ceo: { expansion: 'Chief Executive Officer', meaning: '首席执行官' },
  hr: { expansion: 'human resources', meaning: '人力资源' },
  hrs: { expansion: 'hours', meaning: '小时' },
  km: { expansion: 'kilometre', meaning: '千米' },
  kg: { expansion: 'kilogram', meaning: '千克' },
  cm: { expansion: 'centimetre', meaning: '厘米' },
  ft: { expansion: 'foot / feet', meaning: '英尺' },
  lb: { expansion: 'pound', meaning: '磅' },
  mph: { expansion: 'miles per hour', meaning: '英里每小时' },
  ave: { expansion: 'avenue', meaning: '大街' },
  rd: { expansion: 'road', meaning: '路' },
  dept: { expansion: 'department', meaning: '部门；系' },
  vol: { expansion: 'volume', meaning: '卷；音量' },
  fig: { expansion: 'figure', meaning: '图；数字' },
})

/** 校验时直接并入 allowedWords 的键集合 */
export const ABBREVIATION_WORDS = Object.freeze(Object.keys(ABBREVIATIONS))
