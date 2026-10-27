/**
 * 词库加载器。
 *
 * S5 会在这里读 data/dictionary/*.json，建两个索引：
 *   Map<词头小写, Entry>      精确查找，供 POST /words 回查快照
 *   Map<'a'..'z', Entry[]>    前缀检索，数组顺序即词频顺序
 *
 * 现在只导出空状态，让健康检查从一开始就有稳定的数据来源，
 * S5 替换实现时 health 模块一行都不用改。
 */

export const dictionary = new Map()

/** 加载完成时间，S5 载入成功后赋值（ESM 的 live binding 会同步到导入方） */
export let loadedAt = null
