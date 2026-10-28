import { GenerationTask } from './generation-task.model.js'

/** 只和 Mongoose 打交道，规则在 service 里 */
export const generationTaskRepository = {
  create(data) {
    return GenerationTask.create(data)
  },

  findByIdAndUser(id, userId) {
    return GenerationTask.findOne({ _id: id, userId })
  },

  findByClientToken({ userId, clientToken }) {
    if (!clientToken) return Promise.resolve(null)

    // 同一 token 理论上只有一条；按时间倒序取最新，脏数据也不会让接口报错
    return GenerationTask.findOne({ userId, clientToken }).sort({ createdAt: -1 })
  },

  /** 这个用户当前还在跑的任务（用来做并发闸门与同参复用） */
  findActive(userId) {
    return GenerationTask.findOne({ userId, status: { $in: ['queued', 'running'] } })
      .sort({ createdAt: -1 })
  },

  /**
   * 只更新进行中的任务。
   * 用条件更新而不是先查再改：任务被启动清理标成 failed 之后，
   * 迟到的进度回调不该把状态改回去。
   */
  updateIfActive(id, data) {
    return GenerationTask.findOneAndUpdate(
      { _id: id, status: { $in: ['queued', 'running'] } },
      { $set: data },
      { new: true },
    )
  },

  /** 终态写入：允许覆盖 running，但只在还没到终态时才接受 */
  finish(id, data) {
    return GenerationTask.findOneAndUpdate(
      { _id: id, status: { $in: ['queued', 'running'] } },
      { $set: data },
      { new: true },
    )
  },

  /**
   * 启动清理：进程重启后没有任何执行器会来推进这些任务，
   * 留着只会让前端永远转圈（md/31 §7）。
   */
  failInterrupted(reason) {
    return GenerationTask.updateMany(
      { status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: 'failed',
          stage: 'done',
          finishedAt: new Date(),
          error: reason,
        },
      },
    )
  },

  /** 测试用：不经过 TTL 直接清空 */
  deleteAll() {
    return GenerationTask.deleteMany({})
  },
}
