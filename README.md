# Word Reading 后端

Word Reading 的 API 服务：Express 5 + MongoDB + 本地 COCA 词库 + DeepSeek。
主要能力是「按用户的个人词库，用受限词表生成一篇英语短文 + 阅读理解题」。

接口字段见 [md/05_后端接口说明.md](md/05_后端接口说明.md)，
任务化生成（建任务 + 轮询进度）见 [md/31_生成任务化_方案.md](md/31_生成任务化_方案.md)，
生成动画能用到哪些字段见 [md/32_生成动画_后端支撑.md](md/32_生成动画_后端支撑.md)，
代码结构与不变量见 [md/24_后端代码说明.md](md/24_后端代码说明.md)，
功能边界与已知限制见 [md/13_AI生成文章_功能与限制.md](md/13_AI生成文章_功能与限制.md)，
现存缺陷台账见 [md/23_核心功能现存不足.md](md/23_核心功能现存不足.md)。

## 启动步骤

前置：

| 依赖 | 版本 | 说明 |
| ---- | ---- | ---- |
| Node | ≥ 22 | 用了顶层 `await` 与 ESM |
| MongoDB | 7.x | 本地 `mongod` 或 `docker run -d -p 27017:27017 mongo:7` |
| DeepSeek Key | — | 只有生成接口需要；其它接口没有 key 也能跑 |

```bash
npm i
cp .env.example .env        # Windows: copy .env.example .env
# 编辑 .env：至少确认 MONGODB_URI；要生成文章再填 DEEPSEEK_API_KEY
npm run dev                 # node --watch，改文件自动重启
# 或 npm start
```

启动成功会依次打印三行（顺序即初始化顺序：连库 → 建索引 → 载词库）：

```text
mongo connected: english_code_study_MANGODB
indexes synced
dictionary loaded: 17436 words (filtered 212 of 17648)
basic words loaded: easy 600 (version ...)
```

`dictionary loaded` 这一行如果缺失或数字不对，先查 `data/dictionary/`，
不要急着调生成接口——词库为空时所有词都会被判成表外词。

健康检查：

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","mongo":"connected","dictionary":{"words":17436,"loadedAt":"..."}}
```

Mongo 断开时返回 **503** + `status: "degraded"`，这是唯一的健康判定条件。

## 环境变量

完整清单和注释在 `.env.example`，这里只说「改了会影响什么」。

| 变量 | 默认 | 什么时候要改 |
| ---- | ---- | ------------ |
| `PORT` | 3000 | 本机已有服务占用时（测试实例习惯用 3100–3102） |
| `CLIENT_ORIGIN` | `http://localhost:5173` | 前端换了地址；CORS 只放行这一个 origin |
| `MONGODB_URI` | — | **必填**，缺了进程直接退出并提示 |
| `DEFAULT_USER_ID` | `local-user` | MVP 无登录，所有请求归属它；采样脚本会改成 fixture 用户 |
| `DEEPSEEK_API_KEY` | 空 | 不填也能启动，但生成接口会 502 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 换模型后**必须重新采样**，token 与费用口径都会变 |
| `DEEPSEEK_TIMEOUT_MS` | 60000 | 单次上游调用超时。**必须小于前端 axios 超时（90 s）** |
| `MAX_OUTPUT_TOKENS` | 8192 | 上限不产生费用，按实际 completion_tokens 计费 |
| `GENERATION_STRATEGY` | `segmented` | `whole` 是旧的一次性整篇路径，只用于对照与排查 |
| `SEGMENT_CONCURRENCY` | 4 | 分段并发；调高省延迟、更容易碰到上游限流 |
| `SEGMENT_MAX_ATTEMPTS` | 2 | 每段重写次数（不含首轮与兜底），调高会明显加钱 |
| `VOCABULARY_THRESHOLD` | 20 | A 门的最少候选词数 |
| `MAX_REPAIR_ROUNDS` | 2 | 整篇路径的用词修正轮 |
| `MAX_LENGTH_ROUNDS` | 1 | 超长时的压缩轮 |
| `MAX_EXPAND_ROUNDS` | 0 | 偏短时的补写轮；默认关闭，只记录 `lengthStatus` |
| `RATE_LIMIT_ENABLED` | 非 test 环境为 true | 只影响 `POST /readings/generate` |
| `RATE_LIMIT_GENERATE` | 20 次/分钟 | 按 IP 计 |

`MAX_UNKNOWN_WORDS` 默认留空：生词预算按难度取（easy 0 / medium 3 / hard 5）。
显式设置会把它变成**全局覆盖**，三档压成同一个数，只用于调试与回放对比。

## 测试

```bash
npm test          # vitest run，单进程串行
npm run test:watch
```

每个测试文件起自己的 `mongodb-memory-server`，**首次运行要下载 MongoDB 二进制**
（几十 MB，几分钟），之后走缓存。测试环境会自动把 `GENERATION_STRATEGY` 设为 `whole`、
关掉限流，具体见 `src/tests/setup.js`——所以「测试绿」不等于「分段路径绿」，
分段路径由 `src/tests/segmented.test.js` 单独覆盖。

覆盖率：`npm run test:coverage`（v8 provider）。目前只把
`vocabulary.service.js` 的覆盖率当作验收项，其余模块按需看。

## 词库与数据脚本

词库是**仓库内的静态数据**（`data/dictionary/`，26 个字母分片），启动时全量读进内存，
不走数据库。`meta.json` 记录两个数字，缺一不可：

```text
totalWords      17648   分片里的原始条数
searchableWords 17436   过滤 212 条后真正可检索的条数
```

过滤规则：零义项、词头不匹配 `^[a-z'-]+$`、词头超过 45 字符（详见
`dictionary.loader.js` 的注释）。**不要用 `totalWords` 当验收值**。

重建（需要上游数据仓 `../coca-vocabulary`，不在本仓库）：

```bash
node scripts/build-dictionary.mjs        # 写 data/dictionary/
node scripts/patch-calendar-dictionary.mjs  # 补 COCA 源里没有的 19 个日历词（重建后必须再跑）
node scripts/build-basic-words.mjs       # 只产出 easy 候选稿，不会覆盖三档表
node scripts/build-word-ranks.mjs        # 生成 data/word-ranks.json
```

三档基础词表 `data/basic-words.{easy,medium,hard}.json` 是**人工确认过的成品**，
`build-basic-words.mjs` 默认只写 `*.candidate.json`；扩容用
`extend-basic-words.mjs`（默认以 hard 为基数写回）。误覆盖会让整条生成链路的
词表口径变化，改之前先看 `md/21` §2。

## 运维与采样脚本

| 命令 | 作用 | 会不会写库 / 花钱 |
| ---- | ---- | ----------------- |
| `npm run seed:fixtures` | 造三档 fixture 用户与词库（`--fixture all --anchor YYYY-MM-DD`） | 写库，不花钱 |
| `npm run clean:readings` | 清理调试期阅读记录，**默认 dry-run**，`--yes` 才删 | 删库 |
| `npm run batch:generate` | 批量请求生成接口做采样，**会真实调用模型** | 写库 + 花钱 |
| `node scripts/summarize-runs.mjs` | 只读汇总：成功率、P95、token、费用 | 只读 |
| `npm run replay` | 用离线夹具回放词表校验，验证「改校验器没引入回归」 | 只读 |
| `npm run calibrate` | 诊断历史成功正文的表外词分布；门槛数字已作废，现行值看 `capacity-table.js` | 只读 |

**费用提示**：所有价格按 token 计，DeepSeek 牌价会变，代码里只有默认值。
`summarize-runs.mjs` 支持 `PRICE_CACHE_HIT` / `PRICE_CACHE_MISS` / `PRICE_OUTPUT`
覆盖，并在表尾打印实际使用的单价——用账单对不上时先看那一行。
2026-10-28 的实测均值是 ¥0.0242 / 篇（deepseek-chat，1,501,563 token / 36 次付费请求），
只用于量级参考，不要当报价。

## 目录结构

```text
src/
  app.js                Express 组装（不监听端口，测试直接 supertest）
  server.js             连库 → syncIndexes → 载词库 → listen
  config/               环境变量读取与默认值
  shared/               错误体系、日志、中间件、通用工具
  modules/
    health/             健康检查
    words/              个人词库 CRUD 与选池排序
    dictionary/         COCA 词库加载与前缀检索
    readings/           生成编排、分段闭环、校验、判分、历史
  tests/                vitest（每个文件独立内存 Mongo）
data/                   词库、三档基础词表、不规则词形、词频排名
scripts/                构建、采样、回放、清理
md/                     设计、实施、限制与缺陷文档
```

## 常见错误

| 现象 | 原因 | 处理 |
| ---- | ---- | ---- |
| 启动即退，提示「缺少环境变量：MONGODB_URI」 | 没有 `.env` 或变量名写错 | 复制 `.env.example`，确认数据库名 |
| 启动报 `dictionary` 读取失败 | `data/dictionary/` 缺分片或 `meta.json` | 重新构建词库；不要手改分片 |
| 启动报 `syncIndexes` 失败 | 已有重复数据挡住唯一索引 | 先清理重复的 `userId + word` |
| 端口被占用 `EADDRINUSE` | 3000 上已有实例 | 换 `PORT`；**不要杀 3000 上的用户实例** |
| 生成 502 `AI_PROVIDER_ERROR` | key 错 / 余额不足 / 上游超时 | 看日志里的 `deepseek request failed`，它会抹掉 key 片段 |
| 生成 502 `AI_INVALID_RESPONSE` | 模型输出结构或题目不合格，修正轮也没救回来 | 失败样本在 `GenerationFailure` 里，`finalArticle` 可复查 |
| 生成 429 `RATE_LIMITED` | 同一 IP 超过 20 次/分 | 等窗口结束；批量脚本要设 `RATE_LIMIT_ENABLED=false` |
| 生成 422 `VOCABULARY_TOO_SMALL` | 已知词不够写这么长（门槛随篇幅走，见 `capacity-table.js` 的 `minKnownFor`） | 缩篇幅或加词；这是预期拦截，不是故障 |
| 任务变成 `failed` + `TASK_INTERRUPTED` | 执行实例失联（重启 / kill -9 / OOM），心跳过期后被回收 | 调 `POST /generate/tasks/:id/retry`：已收下的段会复用，只补失败的段（md/31 §11） |
| 生成 400 `final_mode_locked` | hard 写 601–1000 词，但个人词库不足 3000 | 继续攒词；解锁后上限从 600 抬到 1000（md/30 §2.2） |
| 生成 400 `target_words_cap` | 篇幅超过该难度上限（300 / 450 / 600；hard 已解锁时 1000） | 前端滑块上限读 `/capacity` 的 `levels[level].maxTargetWords` |
| 测试首次跑卡住几分钟 | 正在下载 mongodb-memory-server 二进制 | 等它下完；断网环境需要预置缓存 |
