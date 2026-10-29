import mongoose from 'mongoose'

import { config } from '../../config/index.js'

const { Schema } = mongoose

/**
 * 报错日志（md/53）：只存「没被业务接住」的 5xx。
 *
 * 业务错误（400 / 403 / 404 / 409 / 422 / 429）是预期内的分支，答案在
 * access-log 的 statusCode 里，不往这里写——否则这张表会被「用户输错密码」
 * 这类正常事件淹掉，真出问题反而看不见。
 *
 * 与 `GenerationFailure` 的分工：那个表只记生成失败的完整样本（选池、
 * 违规词、rounds），属于业务诊断；这里记的是任何接口的意外异常，属于兜底。
 *
 * 保留 90 天：报错比访问日志少得多，留久一点才能在「用户隔了很久才反馈」时查到。
 */
const errorLogSchema = new Schema(
  {
    requestId: { type: String, default: '', maxlength: 40 },
    method: { type: String, required: true, maxlength: 10 },
    path: { type: String, required: true, maxlength: 400 },
    statusCode: { type: Number, default: 500 },
    // err.code（如 mongoose 的 11000）优先，没有就用 err.name；
    // 普通 Error 的 name 恒为 'Error'，按它分组没有意义，归到 INTERNAL_ERROR
    code: { type: String, default: '', maxlength: 100 },
    message: { type: String, default: '', maxlength: 1000 },
    // 堆栈只给开发排查用，绝不进响应体（errorHandler 的红线）
    stack: { type: String, default: '', maxlength: 8000 },
    ip: { type: String, default: '', maxlength: 64 },
    userId: { type: String, default: '', maxlength: 100 },
    userAgent: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true },
)

errorLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: Math.max(1, config.errorLogRetentionDays) * 24 * 60 * 60 },
)
errorLogSchema.index({ createdAt: -1 })
errorLogSchema.index({ code: 1, createdAt: -1 })
errorLogSchema.index({ ip: 1, createdAt: -1 })

export const ErrorLog = mongoose.model('ErrorLog', errorLogSchema)
