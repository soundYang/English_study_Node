import mongoose from 'mongoose'

import { config } from '../../config/index.js'
import { ERROR_CODES, taskInProgress, taskNotFound } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { parseOrThrow } from '../../shared/utils/validation.js'
import { generationTaskRepository as repo } from './generation-task.repository.js'
import { createTaskSchema } from './reading.schema.js'
import { generateReading } from './reading.service.js'

/**
 * 生成任务的外壳（md/31）。
 *
 * 职责只有三件：建任务、把进度写回任务、把任务翻译成 DTO。
 * **生成逻辑一行都不在这里**——它调的就是 `/readings/generate` 用的
 * 同一个 `generateReading`。两套生成代码并行三个月后一定会分叉，
 * 这是本次改造最重要的一条约束（md/31 §8）。
 */

/**
 * 这些失败改参数才有用，原样重试只会再失败一次。
 * 其余（上游错误、结构非法、残篇、内部异常）都可以直接重新提交。
 */
const NON_RETRYABLE = new Set([
  ERROR_CODES.INSUFFICIENT_VOCABULARY,
  ERROR_CODES.VOCABULARY_TOO_SMALL,
  ERROR_CODES.INVALID_REQUEST,
])

/** 参数比对用：把「集合」语义的 vocabScope 排序，避免 ['all','today_new'] 与反序被当成不同请求 */
function fingerprint(params) {
  return JSON.stringify({
    level: params?.level ?? null,
    targetWords: params?.targetWords ?? null,
    questionCount: params?.questionCount ?? null,
    vocabScope: [...(params?.vocabScope ?? [])].sort(),
  })
}

/**
 * 任务的对外形状。字段与 md/31 §3.2 一一对应，
 * 前端只认这一份，不要另外拼。
 */
export function toTaskDto(task) {
  const failed = task.status === 'failed'
  const error = failed && task.error?.code
    ? {
        code: task.error.code,
        message: task.error.message ?? '',
        details: task.error.details ?? null,
      }
    : null

  return {
    taskId: String(task._id),
    status: task.status,
    stage: task.stage,
    progress: {
      done: task.progress?.done ?? 0,
      total: task.progress?.total ?? 0,
    },
    params: {
      level: task.params?.level ?? null,
      targetWords: task.params?.targetWords ?? null,
      questionCount: task.params?.questionCount ?? null,
      vocabScope: [...(task.params?.vocabScope ?? [])],
    },
    selectedWords: (task.selectedWords ?? []).map((item) => ({
      word: item.word,
      kind: item.kind,
      phonetic: { uk: item.phonetic?.uk ?? '', us: item.phonetic?.us ?? '' },
      senses: (item.senses ?? []).map(({ pos, meaning }) => ({ pos, meaning })),
    })),
    segments: (task.segments ?? []).map((item) => ({
      index: item.index,
      status: item.status,
      words: item.words ?? 0,
    })),
    readingId: task.readingId ? String(task.readingId) : null,
    error,
    // 能不能调 POST /generate/tasks/:id/retry：
    // 参数错、词不够这类换参数才有用，重试只会再失败一次
    retryable: error ? !NON_RETRYABLE.has(error.code) : false,
    // 0 = 第一次跑；每重试一次 +1，前端可以显示「第 2 次尝试 · 复用 7 段」
    retryCount: task.retryCount ?? 0,
    durationMs: task.durationMs ?? null,
    createdAt: task.createdAt ?? null,
  }
}

/**
 * 进度写回。用一个闭包维护段状态，避免「每段回读一次任务文档」。
 *
 * 为什么是闭包而不是直接 $set：段级回调会逐个到达（并发 4 段，但回调按批顺序发出），
 * 每次都算一遍完整数组再整体写回，就不需要 Mongo 的数组过滤器与下标定位。
 * 单进程单任务，闭包与库里的值不会分叉；真分叉了也只是进度显示错，不影响文章。
 */
function makeProgressHandler(taskId) {
  const segments = new Map()
  let total = 0
  let names = []

  const snapshot = () => {
    const list = [...segments.values()].sort((left, right) => left.index - right.index)
    const done = list.filter((item) => item.status === 'accepted' || item.status === 'dropped').length

    return { done, total, list }
  }

  return async (patch) => {
    if (!patch || typeof patch !== 'object') return

    const update = {}

    if (patch.stage) update.stage = patch.stage

    if (Array.isArray(patch.selectedWords)) update.selectedWords = patch.selectedWords

    // 计划定型：续跑的全部依据。写在这里而不是失败之后，是因为
    // 「写了几段之后失败」才是最需要续跑的情况
    if (patch.plan) update.plan = patch.plan

    if (patch.progress && Number.isFinite(patch.progress.total)) {
      total = patch.progress.total
      // 第一次拿到总数就把格子全部建出来：前端要先把 10 个格子画出来，
      // 之后每段落地只是改状态，不是往数组里追加
      if (segments.size === 0) {
        for (let index = 1; index <= total; index += 1) {
          segments.set(index, { index, status: 'pending', words: 0, attempts: 0, text: '' })
        }
      }
    }

    if (patch.segment) {
      const { index, status, words, attempts, text } = patch.segment
      const previous = segments.get(index)

      segments.set(index, {
        index,
        status,
        words: words ?? 0,
        attempts: attempts ?? previous?.attempts ?? 0,
        // 补段失败时不要用空串盖掉上一次收下的正文
        text: text || previous?.text || '',
      })

      if (Array.isArray(patch.segment.names) && patch.segment.names.length > 0) {
        names = patch.segment.names
        update.names = names
      }
    }

    const { done, list } = snapshot()
    update.progress = { done, total }
    if (list.length > 0) update.segments = list

    await repo.updateIfActive(taskId, update)
  }
}

/**
 * 进程内正在跑的任务 → AbortController。
 *
 * 只服务于取消接口：用户点了取消、或者想换一篇重开时，
 * 不该继续为已经没人要的文章付钱。
 */
const activeControllers = new Map()

/** 任务里存的参数是 Mongoose 子文档，展开它拿不到字段，必须显式取一遍 */
function toPlainParams(task) {
  return {
    level: task.params?.level,
    targetWords: task.params?.targetWords,
    questionCount: task.params?.questionCount,
    vocabScope: [...(task.params?.vocabScope ?? [])],
  }
}

/**
 * 任务里存的计划是 Mongoose 子文档，展开它拿不到字段，必须显式取一遍。
 *
 * 三样缺一不可：提示词、分段表（含 limitWords）、已认出的专有名词。
 * 任何一样缺失都退回 `null`，宁可整篇重跑，也不要拼出一篇语气不一致的文章。
 */
function toResumePlan(task) {
  const plan = task.plan
  if (!plan) return null
  if (typeof plan.systemPrompt !== 'string' || !plan.systemPrompt.trim()) return null
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) return null

  return {
    systemPrompt: plan.systemPrompt ?? '',
    segments: plan.segments.map((segment) => ({
      id: segment.id,
      goal: segment.goal ?? '',
      maxWords: segment.maxWords ?? 0,
      limitWords: segment.limitWords ?? 0,
      mustUse: [...(segment.mustUse ?? [])],
    })),
    names: [...(task.names ?? [])],
    segmentTexts: Object.fromEntries(
      (task.segments ?? [])
        .filter((segment) => segment.status === 'accepted' && segment.text)
        .map((segment) => [String(segment.index), segment.text]),
    ),
  }
}

/**
 * 终态写入自带兜底。
 * 这个函数跑在 setImmediate 里没人 await，任何一处 reject 都会变成
 * 进程级的 unhandledRejection——写库失败只该记日志。
 */
async function finishTask(taskId, data) {
  try {
    await repo.finish(taskId, data)
  } catch (error) {
    logger.error({ err: error, taskId }, 'generation task finish writeback failed')
  }
}

/**
 * 真正跑一次生成。异常一律转成任务状态，不往外抛——
 * 这个函数在 setImmediate 里跑，没人 await 它。
 */
async function runTask({ taskId, userId, body, resume = null }) {
  const startedAt = new Date()
  const onProgress = makeProgressHandler(taskId)
  // 任务没有客户端连接可断：这个 signal 只服务于取消接口
  const controller = new AbortController()

  activeControllers.set(String(taskId), controller)

  try {
    const started = await repo.updateIfActive(taskId, {
      status: 'running',
      stage: 'planning',
      startedAt,
    })

    // 排队期间就已经是终态了（取消、启动清理、或者重试请求已经把它改走）：
    // 这条链路没有存在的意义，为一个没人要的任务调模型是真金白银
    if (!started) {
      logger.info({ taskId }, 'generation task no longer active, skipped')
      return
    }

    // 取消接口可能在 updateIfActive 之前就 abort 了（controller 已注册）
    if (controller.signal.aborted) {
      logger.info({ taskId }, 'generation task cancelled before start')
      return
    }

    const dto = await generateReading({
      userId,
      body,
      signal: controller.signal,
      onProgress,
      resume,
    })

    const finishedAt = new Date()

    await finishTask(taskId, {
      status: 'succeeded',
      stage: 'done',
      readingId: dto.id,
      finishedAt,
      durationMs: finishedAt - startedAt,
    })

    logger.info({ taskId, readingId: dto.id, durationMs: finishedAt - startedAt }, 'generation task succeeded')
  } catch (error) {
    // 取消接口已经把状态写成 cancelled，这里再写一次 failed 会把用户的取消改成失败
    if (controller.signal.aborted || error?.name === 'AbortError') {
      logger.info({ taskId }, 'generation task aborted')
      return
    }

    const finishedAt = new Date()
    const code = error?.code ?? ERROR_CODES.INTERNAL_ERROR

    await finishTask(taskId, {
      status: 'failed',
      stage: 'done',
      finishedAt,
      durationMs: finishedAt - startedAt,
      error: {
        code,
        message: error?.message ?? '生成失败，请重试',
        details: error?.details ?? null,
      },
    })

    logger.warn({ taskId, code, durationMs: finishedAt - startedAt }, 'generation task failed')
  } finally {
    activeControllers.delete(String(taskId))
  }
}

/**
 * POST /api/readings/generate/tasks
 *
 * 三道判断按 md/31 §5 的顺序：clientToken → 同参复用 → 不同参报 409。
 * 参数校验在这里同步做完，非法参数不会留下一个注定失败的任务。
 */
export async function createGenerationTask({ userId, body }) {
  const { clientToken, ...generationParams } = parseOrThrow(createTaskSchema, body)

  if (clientToken) {
    const existing = await repo.findByClientToken({ userId, clientToken })
    if (existing) return { task: existing, reused: true }
  }

  const active = await repo.findActive(userId)
  if (active) {
    // 同参数的重复点击（双击、双开页面）直接复用，不扣第二次钱
    if (fingerprint(active.params) === fingerprint(generationParams)) {
      return { task: active, reused: true }
    }

    // 参数不同就不能复用：用户要的是 600 词，给他 200 词的进度是错的
    throw taskInProgress({ taskId: String(active._id) })
  }

  const task = await repo.create({
    userId,
    clientToken: clientToken ?? null,
    status: 'queued',
    stage: 'queued',
    params: {
      level: generationParams.level,
      targetWords: generationParams.targetWords,
      questionCount: generationParams.questionCount,
      vocabScope: generationParams.vocabScope,
    },
    model: config.deepseekModel,
    strategy: config.generationStrategy,
  })

  // setImmediate 而不是直接 await：接口要立刻回 202，
  // 生成在下一个事件循环里开始，HTTP 响应已经写完了
  const taskId = task._id
  setImmediate(() => {
    void runTask({ taskId, userId, body: generationParams })
  })

  return { task, reused: false }
}

/** GET /api/readings/generate/tasks/:id */
export async function getGenerationTask({ userId, id }) {
  // 非法 ObjectId 与不存在走同一个出口：对前端来说都是「这个任务没了」
  if (!mongoose.isValidObjectId(id)) throw taskNotFound()

  const task = await repo.findByIdAndUser(id, userId)
  if (!task) throw taskNotFound()

  return toTaskDto(task)
}

/**
 * POST /api/readings/generate/tasks/:id/cancel
 *
 * 取消是「不再为它付钱」，不是「回滚」：已经收下的段留在任务里，
 * 之后调 retry 还能接着写。终态任务再点取消直接返回当前状态——
 * 网络慢的时候前端连点两次是常态，不该报错。
 */
export async function cancelGenerationTask({ userId, id }) {
  if (!mongoose.isValidObjectId(id)) throw taskNotFound()

  const task = await repo.findByIdAndUser(id, userId)
  if (!task) throw taskNotFound()

  if (task.status !== 'queued' && task.status !== 'running') return toTaskDto(task)

  // 先 abort 再写状态：生成流程看到 signal 已 abort 会直接退出，
  // 不会反过来把 cancelled 覆盖成 failed（runTask 的 catch 里有短路）
  activeControllers.get(String(task._id))?.abort()

  const finishedAt = new Date()
  const updated = await repo.finish(task._id, {
    status: 'cancelled',
    stage: 'done',
    error: null,
    readingId: null,
    finishedAt,
    durationMs: task.startedAt ? finishedAt - task.startedAt : null,
  })

  // finish 是条件更新：正好在这一刻跑完的任务不会被「取消」成 cancelled，
  // 返回库里真实的终态，前端据 status 决定是跳转还是回到生成页
  return toTaskDto(updated ?? (await repo.findByIdAndUser(id, userId)) ?? task)
}

/**
 * POST /api/readings/generate/tasks/:id/retry（md/31 §11 段级续跑）
 *
 * 与「重新建一个任务」的区别只有一处，但省掉的钱最多：
 * 已收下的段正文留在任务里，续跑时这些段不再调模型（`prewritten`），
 * 计划、提示词、段级预算也都用第一次跑的那份。
 *
 * 所以**必须重开同一个任务**，不能新建：新任务没有旧正文。
 */
export async function retryGenerationTask({ userId, id }) {
  if (!mongoose.isValidObjectId(id)) throw taskNotFound()

  const task = await repo.findByIdAndUser(id, userId)
  if (!task) throw taskNotFound()

  // 还在跑 / 已经成功：重试没有意义。连点两次的第二次走到这里，复用而不是报错
  if (task.status === 'queued' || task.status === 'running') return { task, reused: true }
  if (task.status === 'succeeded') return { task, reused: true }

  // 每用户同时只跑一个任务：别的任务还在跑时不能开第二条
  const active = await repo.findActive(userId)
  if (active) throw taskInProgress({ taskId: String(active._id) })

  const body = toPlainParams(task)
  // 计划只在分段路径落库；整篇路径没有续跑的依据，退回整篇重跑
  const resume = config.generationStrategy === 'segmented' ? toResumePlan(task) : null

  const reopened = await repo.reopen(id, {
    status: 'queued',
    stage: 'queued',
    error: null,
    readingId: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    retryCount: (task.retryCount ?? 0) + 1,
    // TTL 建在 createdAt 上，这里一并重置：否则一个快过期的任务重试到一半
    // 会被 TTL 删掉，轮询直接 404，而模型调用已经花出去了
    createdAt: new Date(),
  })

  if (!reopened) {
    // 另一个重试请求刚刚把它改走了：返回库里现在的状态，不起第二条链路
    const latest = await repo.findByIdAndUser(id, userId)
    return { task: latest ?? task, reused: true }
  }

  const taskId = reopened._id
  setImmediate(() => {
    void runTask({ taskId, userId, body, resume })
  })

  return { task: reopened, reused: false }
}

/**
 * 启动清理（md/31 §7）。
 *
 * 任务执行器在进程内，重启后没有任何东西会来推进残留的 queued / running。
 * 不清理的话前端会一直轮询到一个永远不变的进度，比直接报错还糟。
 */
export async function failInterruptedTasks() {
  const result = await repo.failInterrupted({
    code: ERROR_CODES.TASK_INTERRUPTED,
    message: '服务重启导致任务中断，请重新生成',
    details: null,
  })

  const count = result?.modifiedCount ?? 0
  if (count > 0) logger.warn({ count }, 'generation tasks marked interrupted on startup')

  return count
}
