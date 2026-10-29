import { GenerationTask } from './generation-task.model.js'

/**
 * 逐条条件更新，返回真正被翻转的 id。
 *
 * 每个候选都要重新带上原始条件：查询与更新之间任务可能刚好跑完，
 * 不加条件就会把一个成功任务覆盖成 failed（同时还会退错额度）。
 */
async function reclaimEach(staleFilter, patch) {
  const candidates = await GenerationTask.find(staleFilter()).select('_id').lean()
  const reclaimedIds = []

  for (const { _id } of candidates) {
    const flipped = await GenerationTask.findOneAndUpdate(
      { _id, ...staleFilter() },
      {
        $set: patch,
        // 终态必须清掉活跃键，否则这个用户会被一条失败任务永久锁死（md/55 §4.3.3）
        $unset: { activeKey: 1 },
      },
    )

    if (flipped) reclaimedIds.push(_id)
  }

  return { reclaimedIds }
}

/** 只和 Mongoose 打交道，规则在 service 里 */
export const generationTaskRepository = {
  create(data) {
    return GenerationTask.create(data)
  },

  findById(id) {
    return GenerationTask.findById(id)
  },

  findByIdAndUser(id, userId) {
    return GenerationTask.findOne({ _id: id, userId })
  },

  /** 唯一索引报 E11000 后，用它判断是不是一条终态脏数据还占着 activeKey */
  findByActiveKey(activeKey) {
    return GenerationTask.findOne({ activeKey })
  },

  clearActiveKey(id) {
    return GenerationTask.updateOne({ _id: id }, { $unset: { activeKey: 1 } })
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
      {
        _id: id,
        status: 'queued',
        // P0 只允许创建者执行；owner 为空是迁移前的老任务，允许任意实例认领
        $or: [{ owner }, { owner: null }],
      },
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
   * 队列心跳（md/55 §4.4）：排队中的任务还没 claim，但同样需要一个
   * 「我还活着」的标记，否则正常排队超过 taskStaleMs 会被巡检误杀。
   */
  touchQueued(owner, now) {
    return GenerationTask.updateMany(
      { status: 'queued', owner },
      { $set: { heartbeatAt: now } },
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

  /**
   * 改支付路径（md/43 §6.3）：创建时按免费记账，执行时发现用户已经有自备 Key。
   * 只是诊断字段，不参与鉴权；写失败最多让任务表少一个标签，不该影响生成
   */
  setAiKeySource(id, source) {
    return GenerationTask.updateOne({ _id: id }, { $set: { aiKeySource: source } })
  },

  /** 终态写入：允许覆盖 running，但只在还没到终态时才接受 */
  finish(id, data) {
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(data.status)

    return GenerationTask.findOneAndUpdate(
      { _id: id, status: { $in: ['queued', 'running'] } },
      {
        $set: data,
        // 终态必须释放 activeKey，否则同一用户再也建不了新任务
        ...(terminal && { $unset: { activeKey: 1 } }),
      },
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
   *
   * 返回 `reclaimedIds` 而不是 updateMany 的 `modifiedCount`：被回收的任务
   * 是失败终态，要给用户退额度（md/35 §8.1），而批量更新拿不到改了哪几条。
   * 失联任务只是偶尔几条，逐条条件更新不会成为瓶颈。
   */
  async reclaimStaleRunning({ staleBefore, error }) {
    const staleFilter = () => ({
      status: 'running',
      $or: [{ heartbeatAt: { $lt: staleBefore } }, { heartbeatAt: null }],
    })

    return reclaimEach(staleFilter, {
      status: 'failed',
      stage: 'done',
      finishedAt: new Date(),
      owner: null,
      heartbeatAt: null,
      error,
    })
  },

  /**
   * 回收「一直没被认领」的 queued 任务：创建它的实例在 setImmediate 之前就没了。
   *
   * 新任务用队列心跳 `heartbeatAt` 判断（md/55 §4.4）；迁移前的老任务没有
   * heartbeatAt，退回 `updatedAt`，否则一条刚创建的老任务会被立刻误杀。
   */
  async reclaimStaleQueued({ staleBefore, error }) {
    const staleFilter = () => ({
      status: 'queued',
      $or: [
        { heartbeatAt: { $lt: staleBefore } },
        { heartbeatAt: null, updatedAt: { $lt: staleBefore } },
      ],
    })

    return reclaimEach(staleFilter, {
      status: 'failed',
      stage: 'done',
      finishedAt: new Date(),
      owner: null,
      heartbeatAt: null,
      error,
    })
  },

  /**
   * 抢占一次额度退还权（md/35 §6.3）。
   *
   * 失败 / 取消 / 回收三条路径都可能同时触发退款，只有第一次能把
   * `refundedAt` 从 null 改掉。返回**更新前**的文档（含 keys / day），
   * 调用方拿到之后再去减计数；返回 null = 已经退过或根本没占过额度。
   */
  claimQuotaRefund(id, status = null) {
    const filter = { _id: id, 'quota.keys.0': { $exists: true }, 'quota.refundedAt': null }
    // 只退「确实是失败/取消」的任务：生成失败与取消可能和成功写入并发，
    // 不判状态的话会把一篇已经交付的文章也退掉
    if (status) filter.status = status

    return GenerationTask.findOneAndUpdate(
      filter,
      { $set: { 'quota.refundedAt': new Date() } },
      { new: false },
    )
  },

  /** 测试用：不经过 TTL 直接清空 */
  deleteAll() {
    return GenerationTask.deleteMany({})
  },
}
