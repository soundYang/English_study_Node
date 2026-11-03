import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 用户自选单词（md/54）。
 *
 * 四层各测一段：
 *   1. 契约：形状、归一化、数量上限——错了也不该白调模型；
 *   2. 纯函数：合并进目标词计划、选池时不再重复占 supply；
 *   3. 生成：选中词真的进了提示词、最终模式/冷启动不被 freeForm 吞掉；
 *   4. 任务与预检：幂等指纹、重试沿用、/capacity 与真实闸门同源。
 *
 * 上游模型一律打桩；只用 `fixture-*` 之外的表里唯一允许改的默认用户，
 * 每个用例前清库由 setup.js 统一完成。
 */
const { chatJson } = vi.hoisted(() => ({ chatJson: vi.fn() }))

vi.mock('../modules/readings/ai.client.js', () => ({ chatJson }))

const { createApp } = await import('../app.js')
const { config } = await import('../config/index.js')
const { GenerationTask } = await import('../modules/readings/generation-task.model.js')
const { Reading } = await import('../modules/readings/reading.model.js')
const { Word } = await import('../modules/words/word.model.js')
const { generateReadingSchema, capacityQuerySchema } = await import(
  '../modules/readings/reading.schema.js'
)
const { buildTargetPlan, REPEAT_PLAN } = await import(
  '../modules/readings/target-plan.js'
)
const { selectVocabularyPool } = await import('../modules/readings/vocabulary-pool.js')

const app = createApp()

/** 只用基础词 + 声明的人名，过得了词汇校验 */
const ARTICLE =
  'Tom is a good boy. His book is big and the boy is small. Tom and his book play in the house. The book runs and the boy runs too. They are good friends. Tom likes his book very much.'

const payload = {
  title: 'A Good Day',
  article: ARTICLE,
  translation: '汤姆是个好男孩。他和他的书在房子里玩。他们是好朋友。',
  names: ['Tom'],
  questions: Array.from({ length: 3 }, (_, index) => ({
    id: index + 1,
    question: `Question number ${index + 1} about the story?`,
    type: index === 2 ? 'inference' : 'detail',
    evidence: 'Tom is a good boy.',
    options: ['Tom', 'book', 'house', 'friends'],
    correctAnswer: 0,
    explanation: '根据文章内容可知。',
  })),
}

const reply = { content: JSON.stringify(payload), usage: { prompt_tokens: 100, completion_tokens: 200 } }

const wordDoc = (word, { status = 'learning', createdAt, source = 'manual' } = {}) => ({
  userId: config.defaultUserId,
  word,
  status,
  source,
  senses: [{ pos: '', meaning: '测试释义' }],
  ...(createdAt ? { createdAt } : {}),
})

/** easy 100 词的已知词门槛是 647（618 基础词 + 29），400 个填充词足够越过 */
const seedWords = (count, options) =>
  Word.insertMany(
    Array.from({ length: count }, (_, index) =>
      wordDoc(`fill${String(index).padStart(3, '0')}`, options),
    ),
  )

/**
 * 填充词带数字，选词正则不收；能当 focusWords 的词单独造。
 * apple / zebra 不在正文里，book 在——用来验证 missing。
 */
const FOCUS_WORDS = ['apple', 'zebra']
const seedFocusWords = (words = [...FOCUS_WORDS, 'book']) =>
  Word.insertMany(words.map((word) => wordDoc(word)))

const generate = (body) => request(app).post('/api/readings/generate').send(body)
const capacity = (query) => request(app).get('/api/readings/capacity').query(query)

const postTask = (body) => request(app).post('/api/readings/generate/tasks').send(body)
const getTask = (taskId) => request(app).get(`/api/readings/generate/tasks/${taskId}`)
const retryTask = (taskId) => request(app).post(`/api/readings/generate/tasks/${taskId}/retry`)

/** 挂起模型调用，制造「任务还在跑」的窗口 */
function deferredChat() {
  const pending = []

  chatJson.mockImplementation(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  )

  return {
    release(payload = reply) {
      for (const item of pending.splice(0)) item.resolve(payload)
    },
    get size() {
      return pending.length
    },
  }
}

async function waitForFinish(taskId, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    last = await getTask(taskId)
    if (['succeeded', 'failed', 'cancelled'].includes(last.body?.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return last
}

/** 等一个真实条件成立，超时返回 null 让断言失败 */
async function waitFor(check, { timeoutMs = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  return null
}

/** 造 n 个互不相同、只含字母的词，用来探数量上限 */
const letterWords = (n) =>
  Array.from({ length: n }, (_, i) =>
    `word${String.fromCharCode(97 + (i % 26))}${i >= 26 ? String.fromCharCode(97 + Math.floor(i / 26) - 1) : ''}`,
  )

beforeEach(() => {
  chatJson.mockReset()
})

// ——— 1. 契约层 ———

describe('generateReadingSchema · focusWords', () => {
  const body = (extra = {}) => ({
    level: 'easy',
    targetWords: 100,
    questionCount: 3,
    ...extra,
  })
  const parse = (extra) => generateReadingSchema.safeParse(body(extra))

  it('不传时字段保持 undefined，行为与旧请求一致', () => {
    const result = parse({})

    expect(result.success).toBe(true)
    expect(result.data.focusWords).toBeUndefined()
  })

  it('显式空数组 → 400，field 指向 focusWords', () => {
    const result = parse({ focusWords: [] })

    expect(result.success).toBe(false)
    expect(result.error.issues[0].path[0]).toBe('focusWords')
    expect(result.error.issues[0].message).toContain('不能为空数组')
  })

  it('大小写与重复归一化，顺序保持首次出现', () => {
    const result = parse({ focusWords: ['apple', 'Apple', 'apple', 'zebra'] })

    expect(result.success).toBe(true)
    expect(result.data.focusWords).toEqual(['apple', 'zebra'])
  })

  it('弯撇号归一成直撇号', () => {
    const result = parse({ focusWords: ['Don’t'] })

    expect(result.success).toBe(true)
    expect(result.data.focusWords).toEqual(["don't"])
  })

  it('词组 / 纯数字 / 非字符串 / 空串 → 400', () => {
    for (const focusWords of [['apple book'], ['123'], [1], ['']]) {
      const result = parse({ focusWords })
      expect(result.success).toBe(false)
      expect(result.error.issues[0].path[0]).toBe('focusWords')
    }
  })

  it('上限 = targetWords × 0.1：恰好等于通过，多一个 400 且消息带准确上限', () => {
    const max = 10
    const words = letterWords(10)

    expect(parse({ focusWords: words }).success).toBe(true)

    const over = parse({ focusWords: [...words, 'extra'] })
    expect(over.success).toBe(false)
    expect(over.error.issues[0].path[0]).toBe('focusWords')
    expect(over.error.issues[0].message).toContain(`最多 ${max} 个`)
  })

  it('上限跟着篇幅走：300 词可以选 30 个，31 个 → 400', () => {
    const words = letterWords(31)

    expect(parse({ targetWords: 300, focusWords: words.slice(0, 30) }).success).toBe(true)
    expect(parse({ targetWords: 300, focusWords: words }).success).toBe(false)
  })
})

describe('capacityQuerySchema · focusWords', () => {
  const parse = (query) => capacityQuerySchema.safeParse(query)

  it('逗号分隔、兼容重复参数，空项与重复项被丢掉', () => {
    const comma = parse({ targetWords: '200', focusWords: ' Apple, apple,,book ' })
    expect(comma.success).toBe(true)
    expect(comma.data.focusWords).toEqual(['apple', 'book'])

    const repeated = parse({ targetWords: '200', focusWords: ['apple', 'book'] })
    expect(repeated.data.focusWords).toEqual(['apple', 'book'])
  })

  it('空串 = 没有选词，不挡诊断页', () => {
    const result = parse({ targetWords: '200', focusWords: '' })

    expect(result.success).toBe(true)
    expect(result.data.focusWords).toEqual([])
  })

  it('数量同样受 targetWords × 0.1 限制', () => {
    const words = Array.from({ length: 21 }, (_, i) => `w${String.fromCharCode(97 + i)}`)
    const result = parse({ targetWords: '200', focusWords: words.join(',') })

    expect(result.success).toBe(false)
    expect(result.error.issues[0].path[0]).toBe('focusWords')
  })
})

// ——— 2. 纯函数 ———

/** 顺序即「已排好序」的顺序 */
const makePool = (n) =>
  Array.from({ length: n }, (_, i) => `w${String(i + 1).padStart(4, '0')}`)

const plan = (params) => buildTargetPlan({ level: 'medium', ...params })

describe('buildTargetPlan · 自选词合并', () => {
  it('不传选词时与旧输出逐项相等（防回归）', () => {
    const pool = makePool(100)
    const result = plan({ pool, targetWords: 300 })

    expect(result).toEqual({
      requiredWords: 30,
      focusWords: pool.slice(0, 11),
      targetWords: pool.slice(11, 30),
      supportWords: pool.slice(30),
      repeatPlan: REPEAT_PLAN,
    })
  })

  it('选 3 / 15 / 30 个：全部进必用清单，总数仍是 30，无重复', () => {
    const pool = makePool(100)

    for (const count of [3, 15, 30]) {
      const selected = pool.slice(0, count)
      const result = plan({ pool, targetWords: 300, selectedWords: selected })
      const mustUse = [...result.focusWords, ...result.targetWords]

      expect(mustUse).toHaveLength(30)
      expect(new Set(mustUse).size).toBe(30)
      for (const word of selected) expect(mustUse).toContain(word)

      // ★ 只给前 focusCount（11）个选中词，避免 30 个词全被要求复现 2–3 次
      expect(result.focusWords.slice(0, Math.min(count, 11))).toEqual(
        selected.slice(0, 11),
      )

      const merged = [...mustUse, ...result.supportWords]
      expect(merged).toHaveLength(pool.length)
      expect(new Set(merged).size).toBe(pool.length)
    }
  })

  it('选中词不在池子里也照样进入计划，supportWords 不重复', () => {
    const pool = makePool(100)
    const result = plan({
      pool,
      targetWords: 100,
      selectedWords: ['zzz', 'w0001'],
    })

    expect(result.focusWords).toContain('zzz')
    expect(result.focusWords).toContain('w0001')
    expect(result.supportWords).not.toContain('zzz')
    expect(result.supportWords).not.toContain('w0001')
    expect([...result.focusWords, ...result.targetWords]).toHaveLength(10)
  })

  it('selectTargets:false + 选词：requiredWords = 选词数，全部是重点词', () => {
    const pool = makePool(50)
    const result = plan({
      pool,
      targetWords: 700,
      selectTargets: false,
      selectedWords: ['w0001', 'zzz'],
    })

    expect(result.requiredWords).toBe(2)
    expect(result.focusWords).toEqual(['w0001', 'zzz'])
    expect(result.targetWords).toEqual([])
    expect(result.supportWords).toHaveLength(49)
    expect(result.supportWords).not.toContain('w0001')
  })

  it('selectTargets:false 且没选词：与旧的自由写作输出相等', () => {
    const pool = makePool(20)
    const result = plan({ pool, targetWords: 700, selectTargets: false })

    expect(result).toEqual({
      requiredWords: 0,
      focusWords: [],
      targetWords: [],
      supportWords: pool,
      repeatPlan: REPEAT_PLAN,
    })
  })
})

const NOW = new Date('2026-10-27T12:00:00')
const makeWord = (word, extra = {}) => ({
  word,
  status: 'learning',
  cocaRank: 100,
  createdAt: new Date('2026-10-01T00:00:00'),
  lastReviewedAt: null,
  ...extra,
})
const makeWords = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) =>
    makeWord(`w${String(i + 1).padStart(3, '0')}`, { cocaRank: i + 1, ...extra }),
  )
const pool = (params) => selectVocabularyPool({ now: NOW, ...params })

describe('selectVocabularyPool · preselected', () => {
  it('不传 preselected 时数字与旧实现一致', () => {
    const result = pool({ words: makeWords(200), level: 'hard', targetWords: 800 })

    expect(result).toMatchObject({
      poolSize: 140,
      available: 200,
      requiredWords: 80,
      neededVocab: 115,
      sufficient: true,
      selectedCount: 0,
      remainingRequired: 80,
      supply: 200,
    })
  })

  it('选词覆盖全部配额 → 即使 scope 内一个词也没有也算够', () => {
    // 词都是旧的，按 today_new 过滤后 available = 0
    const words = makeWords(50)
    const selected = Array.from({ length: 80 }, (_, i) => `picked${i}`)

    const result = pool({
      words,
      level: 'hard',
      targetWords: 800,
      scope: ['today_new'],
      preselected: selected,
    })

    expect(result.available).toBe(0)
    expect(result.selectedCount).toBe(80)
    expect(result.remainingRequired).toBe(0)
    expect(result.neededVocab).toBe(0)
    expect(result.sufficient).toBe(true)
  })

  it('scope 外的选中词仍然计入 supply，不会被当成「补词」再扣一次', () => {
    const words = [
      ...makeWords(50).map((word) => ({ ...word, createdAt: new Date('2026-10-27T02:00:00') })),
      ...makeWords(50),
    ]
    // 选中 10 个 scope 外的旧词：scope 内 available = 50
    const outOfScope = Array.from({ length: 10 }, (_, i) => `old${i}`)

    const result = pool({
      words,
      level: 'hard',
      targetWords: 800,
      scope: ['today_new'],
      preselected: outOfScope,
    })

    expect(result.available).toBe(50)
    expect(result.selectedCount).toBe(10)
    expect(result.remainingRequired).toBe(70)
    // 50 + 10 − 10 = 50：选中词从 supply 里扣掉，scope 外那部分补回来
    expect(result.supply).toBe(50)
    expect(result.neededVocab).toBe(100)
    expect(result.sufficient).toBe(false)
  })

  it('剩余配额仍不足时 sufficient=false，数字符合公式', () => {
    const words = makeWords(45)
    const selected = words.slice(0, 10).map((word) => word.word)

    const result = pool({
      words,
      level: 'hard',
      targetWords: 800,
      preselected: selected,
    })

    expect(result.available).toBe(45)
    expect(result.selectedCount).toBe(10)
    expect(result.remainingRequired).toBe(70)
    expect(result.supply).toBe(35)
    expect(result.neededVocab).toBe(100)
    expect(result.sufficient).toBe(false)
  })
})

// ——— 3. 生成 ———

describe('POST /api/readings/generate · 自选词', () => {
  it('选中词进【目标词】段，★ 数量仍是 focusCount', async () => {
    await seedWords(400)
    await seedFocusWords()
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['apple', 'zebra'],
    })

    expect(res.status).toBe(201)

    const prompt = chatJson.mock.calls[0][0].messages[1].content
    expect(prompt).toContain('【目标词】共 10 个')
    expect(prompt).toContain('其中加 ★ 的 4 个重点词')
    expect(prompt).toContain('★ apple')
    expect(prompt).toContain('★ zebra')

    const doc = await Reading.findById(res.body.id)
    // 选中的两个词都在 ★ 段
    expect(doc.targetPlan.focusWords.slice(0, 2)).toEqual(['apple', 'zebra'])
    expect(doc.targetPlan.selectedWords).toEqual(['apple', 'zebra'])
    expect(doc.targetPlan.requiredWords).toBe(10)
  })

  it('词库里没有的词 → 422 FOCUS_WORDS_NOT_LEARNED，不调模型', async () => {
    await seedWords(400)
    await seedFocusWords(['apple'])
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['apple', 'ghostword'],
    })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('FOCUS_WORDS_NOT_LEARNED')
    expect(res.body.error.field).toBe('focusWords')
    expect(res.body.error.details).toMatchObject({
      kind: 'focus_words',
      words: ['ghostword'],
      count: 1,
      max: 10,
    })
    expect(chatJson).not.toHaveBeenCalled()
    expect(await Reading.countDocuments()).toBe(0)
  })

  it('标记为「不认识」的墓碑词不能指定', async () => {
    await seedWords(400)
    await Word.create(wordDoc('zzznew', { status: 'new', source: 'basic-removed' }))
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['zzznew'],
    })

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('FOCUS_WORDS_NOT_LEARNED')
    expect(res.body.error.details.words).toEqual(['zzznew'])
    expect(chatJson).not.toHaveBeenCalled()
  })

  it('用户自己添加的 status=new 词可以指定（md/60）', async () => {
    await seedWords(400)
    await Word.create(wordDoc('freshword', { status: 'new' }))
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['freshword'],
    })

    expect(res.status).toBe(201)
    expect(res.body.focusWords.requested).toEqual(['freshword'])
    expect(chatJson).toHaveBeenCalled()
  })

  it('DTO 的 requested / missing 与正文实际命中一致', async () => {
    await seedWords(400)
    await seedFocusWords()
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['book', 'apple'],
    })

    expect(res.status).toBe(201)
    // book 在正文里，apple 不在
    expect(res.body.focusWords).toEqual({
      requested: ['book', 'apple'],
      missing: ['apple'],
    })
  })

  it('覆盖度低于 0.9 只告警，仍然 201', async () => {
    await seedWords(400)
    await seedFocusWords()
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['apple', 'zebra'],
    })

    expect(res.status).toBe(201)
    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.targetUsage.coverageRate).toBeLessThan(0.9)
    expect(doc.aiMeta.targetUsage.unused).toEqual(
      expect.arrayContaining(['apple', 'zebra']),
    )
  })

  it('最终模式 + 选词：不再走自由写作，选中词成为唯一必用词', async () => {
    await seedWords(3000)
    await seedFocusWords(['apple', 'zebra'])
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'hard',
      targetWords: 700,
      questionCount: 3,
      focusWords: ['apple', 'zebra'],
    })

    expect(res.status).toBe(201)

    const system = chatJson.mock.calls[0][0].messages[0].content
    expect(system).not.toContain('本次没有指定的目标词')
    expect(system).toContain('必须全部出现在正文中')

    const prompt = chatJson.mock.calls[0][0].messages[1].content
    expect(prompt).toContain('★ apple')
    expect(prompt).toContain('★ zebra')

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.finalMode).toBe(true)
    expect(doc.targetPlan.requiredWords).toBe(2)
    expect(doc.targetPlan.focusWords).toEqual(['apple', 'zebra'])
    expect(doc.targetPlan.selectedWords).toEqual(['apple', 'zebra'])
    // 只有这两个必用词，没有自动补的目标词
    expect(prompt).toContain('【目标词】共 2 个')
  })

  it('冷启动 + 选词：生成成功，选中词进重点词，命中时 missing 为空', async () => {
    // personalWords = 1 < neededVocabulary(100, easy) = 29 → 冷启动
    await Word.create(wordDoc('book'))
    chatJson.mockResolvedValue(reply)

    const res = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      focusWords: ['book'],
    })

    expect(res.status).toBe(201)
    expect(res.body.focusWords).toEqual({ requested: ['book'], missing: [] })

    const doc = await Reading.findById(res.body.id).lean()
    expect(doc.aiMeta.coldStart).toBe(true)
    expect(doc.targetPlan.requiredWords).toBe(1)
    expect(doc.targetPlan.focusWords).toEqual(['book'])
  })
})

// ——— 4. 任务与预检 ———

describe('生成任务 · focusWords', () => {
  const BODY = { level: 'easy', targetWords: 100, questionCount: 3 }

  it('建任务回显选词；不传时为 null', async () => {
    await seedWords(400)
    await seedFocusWords()
    const gate = deferredChat()

    const withFocus = await postTask({ ...BODY, focusWords: ['apple', 'zebra'] })
    expect(withFocus.status).toBe(202)
    expect(withFocus.body.params.focusWords).toEqual(['apple', 'zebra'])

    expect(await waitFor(() => gate.size > 0)).toBe(true)
    gate.release()
    await waitForFinish(withFocus.body.taskId)

    const plain = await postTask(BODY)
    expect(plain.status).toBe(202)
    expect(plain.body.params.focusWords).toBeNull()

    expect(await waitFor(() => gate.size > 0)).toBe(true)
    gate.release()
    await waitForFinish(plain.body.taskId)
  })

  it('同一组选词重复提交复用任务；选词不同 → 409', async () => {
    await seedWords(400)
    await seedFocusWords()
    const gate = deferredChat()

    const first = await postTask({ ...BODY, focusWords: ['apple'] })
    const same = await postTask({ ...BODY, focusWords: ['apple'] })
    const different = await postTask({ ...BODY, focusWords: ['zebra'] })

    expect(same.body.reused).toBe(true)
    expect(same.body.taskId).toBe(first.body.taskId)

    expect(different.status).toBe(409)
    expect(different.body.error.code).toBe('TASK_IN_PROGRESS')

    expect(await waitFor(() => gate.size > 0)).toBe(true)
    gate.release()
    await waitForFinish(first.body.taskId)
  })

  it('重试沿用选词，提示词里仍有 ★，且不会因空数组校验失败', async () => {
    await seedWords(400)
    await seedFocusWords()
    chatJson.mockRejectedValue(
      Object.assign(new Error('upstream down'), { code: 'AI_PROVIDER_ERROR' }),
    )

    const { body } = await postTask({ ...BODY, focusWords: ['apple'] })
    const failed = await waitForFinish(body.taskId)
    expect(failed.body.status).toBe('failed')
    // 上游错误可以重试
    expect(failed.body.retryable).toBe(true)

    chatJson.mockReset()
    chatJson.mockResolvedValue(reply)

    const res = await retryTask(body.taskId)
    expect(res.status).toBe(202)

    const done = await waitForFinish(body.taskId)
    expect(done.body.status).toBe('succeeded')
    expect(done.body.params.focusWords).toEqual(['apple'])

    const prompt = chatJson.mock.calls[0][0].messages[1].content
    expect(prompt).toContain('★ apple')
    expect(await Reading.countDocuments()).toBe(1)
  })

  it('选词不在词库 → 失败且不可重试', async () => {
    await seedWords(400)
    await seedFocusWords(['apple'])

    const { body } = await postTask({ ...BODY, focusWords: ['ghostword'] })
    const done = await waitForFinish(body.taskId)

    expect(done.body.status).toBe('failed')
    expect(done.body.error.code).toBe('FOCUS_WORDS_NOT_LEARNED')
    expect(done.body.retryable).toBe(false)
    expect(await GenerationTask.countDocuments()).toBe(1)
  })
})

describe('GET /capacity · focusWords', () => {
  it('返回 requested / invalid / max，无效词不参与折算', async () => {
    await seedWords(400)
    await seedFocusWords(['apple'])

    const res = await capacity({ targetWords: 200, focusWords: 'apple,ghostword' })

    expect(res.status).toBe(200)
    expect(res.body.focusWords).toEqual({
      requested: ['apple', 'ghostword'],
      invalid: ['ghostword'],
      max: 20,
    })
  })

  it('选词占满配额时 A 门直接放行，即使 scope 内没有词', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await seedWords(400, { createdAt: yesterday })
    const picked = ['alpha', 'bravo', 'camel', 'delta', 'eagle', 'fable', 'giant', 'honey', 'igloo', 'joker']
    await Word.insertMany(picked.map((word) => wordDoc(word, { createdAt: yesterday })))

    const without = await capacity({ targetWords: 100, vocabScope: 'today_new' })
    expect(without.body.levels.easy).toMatchObject({
      available: 0,
      required: 29,
      // md/60：today_new 首次不够时从全部词汇兜底，A 门不再直接判死
      sufficient: true,
      shortage: 0,
    })
    expect(without.body.levels.easy.fallback).toMatchObject({
      used: true,
      requestedScope: ['today_new'],
      scopeAvailable: 0,
    })

    const withFocus = await capacity({
      targetWords: 100,
      vocabScope: 'today_new',
      focusWords: picked.join(','),
    })
    expect(withFocus.body.levels.easy).toMatchObject({
      available: 0,
      required: 0,
      sufficient: true,
      shortage: 0,
    })

    // 预检说能，真的点下去也能
    chatJson.mockResolvedValue(reply)
    const generated = await generate({
      level: 'easy',
      targetWords: 100,
      questionCount: 3,
      vocabScope: ['today_new'],
      focusWords: picked,
    })
    expect(generated.status).toBe(201)
  })
})
