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
    // 阶段一的语义是「可以重新提交一个新任务」；段级续跑落地后才会变成「只补失败段」
    retryable: error ? !NON_RETRYABLE.has(error.code) : false,
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
  let stage = 'planning'
  let selectedWords = null

  const snapshot = () => {
    const list = [...segments.values()].sort((left, right) => left.index - right.index)
    const done = list.filter((item) => item.status === 'accepted' || item.status === 'dropped').length

    return { done, total, list }
  }

  return async (patch) => {
    if (!patch || typeof patch !== 'object') return

    const update = {}

    if (patch.stage) {
      stage = patch.stage
      update.stage = stage
    }

    if (Array.isArray(patch.selectedWords)) {
      selectedWords = patch.selectedWords
      update.selectedWords = selectedWords
    }

    if (patch.progress && Number.isFinite(patch.progress.total)) {
      total = patch.progress.total
      // 第一次拿到总数就把格子全部建出来：前端要先把 10 个格子画出来，
      // 之后每段落地只是改状态，不是往数组里追加
      if (segments.size === 0) {
        for (let index = 1; index <= total; index += 1) {
          segments.set(index, { index, status: 'pending', words: 0 })
        }
      }
    }

    if (patch.segment) {
      const { index, status, words } = patch.segment
      segments.set(index, { index, status, words: words ?? 0 })
    }

    const { done, list } = snapshot()
    update.progress = { done, total }
    if (list.length > 0) update.segments = list

    await repo.updateIfActive(taskId, update)
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
async function runTask({ taskId, userId, body }) {
  const startedAt = new Date()
  const onProgress = makeProgressHandler(taskId)

  try {
    await repo.updateIfActive(taskId, { status: 'running', stage: 'planning', startedAt })
    const dto = await generateReading({
      userId,
      body,
      // 任务没有客户端连接可断，signal 只留给将来的取消接口（md/31 §11）
      signal: new AbortController().signal,
      onProgress,
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
