/**
 * 星期与月份白名单。
 *
 * COCA 词元表把这类专有名词整类剔除了：2 万词源数据里搜不到 saturday，
 * 词库里也一条都没有。所以它们永远进不了 basic-words.json（排名捞不到），
 * 用户在前端也搜不到、加不进自己的词表——写"周末/日常作息"的文章必然判超纲。
 * 提示词里写多少规则都兜不住，只能在服务端放行。
 *
 * 校验前所有词都会转小写，这里保持小写即可，正文里的 Saturday 照样命中。
 */
export const calendarWords = Object.freeze([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
])
