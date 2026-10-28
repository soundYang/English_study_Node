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
   * 抢占任务（md/31 §11 多实例）。
   *
   * 只认 `queued`：两个实例同时拿到同一个任务时，原子条件更新保证只有
   * 一个能把它改成 running。抢不到的那个直接退出，不会重复烧钱。
   */
  claim(id, { owner, now }) {
    return GenerationTask.findOneAndUpdate(
      { _id: id, status: 'queued' },
      {
        $set: {
          status: 'running',
          stage: 'planning',
          startedAt: now,
          owner,
          heartbeatAt: now,
        },
      },
      { new: true },
    )
  },

  /**
   * 心跳续租。返回 null = **已经不再持有这个任务**（被取消、被巡检回收、
   * owner 被清空）。调用方看到 null 就该停手——这是租约的全部含义。
   */
  heartbeat(id, owner, now) {
    return GenerationTask.findOneAndUpdate(
      { _id: id, owner, status: 'running' },
      { $set: { heartbeatAt: now } },
      { new: true },
    )
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
   * 重开一个终态任务（md/31 §11 段级续跑）。
   *
   * 条件更新：两个重试请求同时打进来，只有一个能把 failed/cancelled 改成 queued，
   * 另一个拿到 null 就知道「已经有人在重试」，不会起第二条生成链路。
   */
  reopen(id, data) {
    return GenerationTask.findOneAndUpdate(
      { _id: id, status: { $in: ['failed', 'cancelled'] } },
      { $set: data },
      { new: true },
    )
  },

  /**
   * 回收**心跳过期**的 running 任务（md/31 §11）。
   *
   * 为什么不能像单进程时代那样全表 updateMany：多实例下，别的实例正在跑的
   * 任务心跳是新的，一重启就把它们一起标成失败，等于谁重启谁误杀别人。
   * `heartbeatAt: null` 也要收：那是加租约之前留下的旧文档，确实没有实例在续租。
   */
  reclaimStaleRunning({ staleBefore, error }) {
    return GenerationTask.updateMany(
      {
        status: 'running',
        $or: [{ heartbeatAt: { $lt: staleBefore } }, { heartbeatAt: null }],
      },
      {
        $set: {
          status: 'failed',
          stage: 'done',
          finishedAt: new Date(),
          owner: null,
          error,
        },
      },
    )
  },

  /**
   * 回收「一直没被认领」的 queued 任务：创建它的实例在 setImmediate 之前就没了。
   *
   * 用 `updatedAt` 而不是 `createdAt`：重试会重置 createdAt，而重试后的
   * 任务也应该在这么久没被认领时被回收。
   */
  reclaimStaleQueued({ staleBefore, error }) {
    return GenerationTask.updateMany(
      { status: 'queued', updatedAt: { $lt: staleBefore } },
      {
        $set: {
          status: 'failed',
          stage: 'done',
          finishedAt: new Date(),
          error,
        },
      },
    )
  },

  /** 测试用：不经过 TTL 直接清空 */
  deleteAll() {
    return GenerationTask.deleteMany({})
  },
}
