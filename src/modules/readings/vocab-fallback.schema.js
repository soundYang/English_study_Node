import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * 词源兜底说明（md/60）。
 *
 * Reading 与 GenerationTask 共用同一份子 schema：
 * 两处各写一套字段，迟早会出现「任务里有、文章详情里没有」的分叉。
 * `message` 是后端生成好的中文提示，前端直接展示，不要自行拼接。
 */
export const vocabFallbackSchema = new Schema(
  {
    used: { type: Boolean, default: false },
    // 用户原本选的词源，不因为兜底改成 ['all']
    requestedScope: { type: [String], default: [] },
    scopeAvailable: { type: Number, default: 0 },
    allAvailable: { type: Number, default: 0 },
    needed: { type: Number, default: 0 },
    // 实际进入候选池的补充词数，不是全库差量
    supplemented: { type: Number, default: 0 },
    message: { type: String, default: '' },
  },
  { _id: false },
)

/**
 * 对外 DTO。只在 `used === true` 时返回，避免正常请求多出一个恒为 null 的字段。
 */
export function toVocabFallbackDto(fallback) {
  if (!fallback?.used) return null

  return {
    used: true,
    requestedScope: [...(fallback.requestedScope ?? [])],
    scopeAvailable: fallback.scopeAvailable ?? 0,
    allAvailable: fallback.allAvailable ?? 0,
    needed: fallback.needed ?? 0,
    supplemented: fallback.supplemented ?? 0,
    message: fallback.message ?? '',
  }
}
