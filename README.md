# Word Reading 后端

Word Reading 的 API 服务：Express 5 + MongoDB + 本地 COCA 词库 + DeepSeek。
主要能力是「按用户的个人词库，用受限词表生成一篇英语短文 + 阅读理解题」。

接口字段见 [md/05_后端接口说明.md](md/05_后端接口说明.md)，
任务化生成（建任务 + 轮询进度）见 [md/31_生成任务化_方案.md](md/31_生成任务化_方案.md)，
生成动画能用到哪些字段见 [md/32_生成动画_后端支撑.md](md/32_生成动画_后端支撑.md)，
用户与鉴权（个人中心）的口径见 [md/33_用户与鉴权_方案.md](md/33_用户与鉴权_方案.md)，
登录/注册/个人中心接口怎么调见 [md/34_用户与鉴权_接口文档.md](md/34_用户与鉴权_接口文档.md)，
每日生成额度与设备识别（防薅羊毛）的方案见 [md/35_每日额度与设备识别_方案.md](md/35_每日额度与设备识别_方案.md)，
全局免费 token 预算（2 亿封顶）见 [md/36_全局免费额度预算_方案.md](md/36_全局免费额度预算_方案.md)，
管理员后台（用户台账 + 反馈）见 [md/37_管理员后台_方案.md](md/37_管理员后台_方案.md)，
冷启动生成（0 词也能写 100 / 200 词）见 [md/39_冷启动生成_方案.md](md/39_冷启动生成_方案.md)，
管理员后台页面（`/admin`，配色与用户端一致）见 [md/40_管理员后台页面_方案.md](md/40_管理员后台页面_方案.md)，
生词容忍开关（easy 固定 0，medium / hard 可选）见 [md/41_生词容忍开关_方案.md](md/41_生词容忍开关_方案.md)，
最终模式下生词容忍默认开启见 [md/42_最终模式生词默认开启.md](md/42_最终模式生词默认开启.md)，
用户自备 DeepSeek API Key 见 [md/43_用户自备API_Key_方案.md](md/43_用户自备API_Key_方案.md)，
代码结构与不变量见 [md/24_后端代码说明.md](md/24_后端代码说明.md)，
功能边界与已知限制见 [md/13_AI生成文章_功能与限制.md](md/13_AI生成文章_功能与限制.md)，
现存缺陷台账见 [md/23_核心功能现存不足.md](md/23_核心功能现存不足.md)，
后端缺陷与安全审查见 [md/45_后端缺陷与安全审查.md](md/45_后端缺陷与安全审查.md)，
管理端查看「谁接入了自备 Key」见 [md/47_管理端自备Key可见性.md](md/47_管理端自备Key可见性.md)，
文件（Word / Excel / 图片）导入单词的方案见 [md/48_单词导入_Word_Excel_图片_方案.md](md/48_单词导入_Word_Excel_图片_方案.md)，
导入时用自备 Key 走 AI 识别（默认关）见 [md/49_单词导入_AI识别_自备Key方案.md](md/49_单词导入_AI识别_自备Key方案.md)，
基础词汇库对游客开放（只读公开接口）见 [md/50_基础词汇库_游客只读_方案.md](md/50_基础词汇库_游客只读_方案.md)，
手填单词也自动补词库快照（音标 / 词性 / 完整义项）见 [md/51_手填单词_词库快照补全_方案.md](md/51_手填单词_词库快照补全_方案.md)，
基础词页的类型徽标与「未标记 / 认识 / 不认识」三态标记见 [md/52_基础词类型标签与三态标记_方案.md](md/52_基础词类型标签与三态标记_方案.md)，
访问 / 报错 / 登录日志落库与后台查询（含用户 IP、登录记录、汇总）见 [md/53_访问日志与报错日志落库_方案.md](md/53_访问日志与报错日志落库_方案.md)。

## 启动步骤

前置：

| 依赖 | 版本 | 说明 |
| ---- | ---- | ---- |
| Node | ≥ 22 | 用了顶层 `await` 与 ESM |
| MongoDB | 7.x | 本地 `mongod` 或 `docker run -d -p 27017:27017 mongo:7` |
| DeepSeek Key | — | 只有生成接口需要；其它接口没有 key 也能跑 |

**MongoDB 必须先于后端启动**（`mongod` 没装成服务时，关掉它的终端就会停）。连库失败时
启动会直接退出；已启动后断开则 `/api/health` 返回 503 `degraded`——先看这一项，再怀疑前端网络。

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
| `CLIENT_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | 前端换了地址。**多个用逗号分隔**（局域网联调写 `http://localhost:5173,http://127.0.0.1:5173,http://192.168.x.x:5173`），结尾斜杠会被忽略。按源精确匹配：`localhost` 与 `127.0.0.1`、vite 打印的每个网卡 IP 都是不同的源，漏配就会 `ERR_FAILED` + 页面「网络错误」 |
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
| `WORD_LIBRARY_LIMIT` | 5000 | 个人词库上限，只对新建计数；合并已有词不受限。`0` = 不限制。超限返回 409 `WORD_LIMIT_REACHED`（md/44） |
| `RATE_LIMIT_ENABLED` | 非 test 环境为 true | 影响 `POST /readings/generate` 与 `POST /api/words/check` |
| `RATE_LIMIT_GENERATE` | 20 次/分钟 | 按 IP 计 |
| `DAILY_QUOTA_ENABLED` | true | 每日额度总开关。前端 `X-Device-Id` 已上线，默认打开；**批量采样实例要显式设 false**，否则网络指纹桶（10 次/天）会把 3100–3102 打成 429 |
| `DAILY_QUOTA_ACCOUNT` / `_DEVICE` / `_NETWORK` | 3 / 3 / 10 | 账号 / 设备 / 网络指纹的每日次数（md/35） |
| `TRUST_PROXY` | false | 部署在 nginx / CDN 后面时必须配（`1` 或 `loopback`），否则 `req.ip` 全是反代地址 |
| `TOKEN_BUDGET_ENABLED` | true | 全局免费池总开关；到顶后所有生成返回 503（md/36） |
| `FREE_TOKEN_BUDGET` | 200000000 | 免费池总量（token）。到顶是**永久停服**，不是每日恢复 |
| `ADMIN_USERNAME` | 空 | 管理员账号（只有一个）。留空则 `/api/admin/*` 整体 404（md/37） |
| `ADMIN_PASSWORD_HASH` | 空 | scrypt 哈希，用 `node scripts/hash-admin-password.mjs '密码'` 生成；明文永不入库 |
| `USER_API_KEY_ENABLED` | true | 自备 Key 总开关；**生效还需要 `USER_API_KEY_SECRET`**，缺任一项时 `GET /api/profile/api-key` 返回 `enabled: false`（md/43） |
| `USER_API_KEY_SECRET` | 空 | 加密主密钥，`node scripts/gen-user-key-secret.mjs` 生成；丢失后存量 Key 全部无法解密 |
| `USER_API_KEY_SECRET_PREVIOUS` | 空 | 轮换期间保留的旧主密钥；两张表都匹配不上时按免费路径处理 |
| `USER_API_KEY_VERIFY_TIMEOUT_MS` | 8000 | 导入时请求上游 `/models` 的超时，不重试 |
| `RATE_LIMIT_API_KEY` | 5 次/分钟 | `PUT` / `DELETE` / `verify` 共用同一个桶（按 IP） |
| `OCR_ENABLED` | true | 图片导入总开关；关掉后图片返回 422 `OCR_FAILED`，Word / Excel 不受影响（md/48） |
| `OCR_LANG` | `eng` | 识别语言，多个用 `+` 连接。仓库只带 `eng`：快速模式只取英文词，释义留空由词库补 |
| `OCR_LANG_PATH` | 空 | 模型目录。留空 = 用仓库自带的 `data/ocr`；目录不存在时退回 CDN（首次要下 2MB） |
| `OCR_CACHE_PATH` | 空 | 留空 = 不写缓存。模型已在本地，缓存只会再占 4MB |
| `OCR_TIMEOUT_MS` | 20000 | 单张图识别超时；超时的 worker 直接销毁，不放回池 |
| `OCR_WORKERS` | 2 | 常驻 worker 数 = 同时识别几张图；每个约 50–80MB 内存 |
| `IMPORT_AI_ENABLED` | true | 导入 AI 识别的**能力**开关。请求默认 `mode=local`，只有显式 `mode=ai` 且账号接了自备 Key 才会调模型；关掉后 `mode=ai` 一律 403（md/49） |
| `IMPORT_AI_MAX_ROWS_PER_CALL` | 150 | 每片最多多少行，也是输出 token 的主要闸门（150 × 约 28 token） |
| `IMPORT_AI_MAX_CHARS_PER_CALL` | 6000 | 文本形态下每片最多多少字符；不会把一行从中间劈开 |
| `IMPORT_AI_MAX_CALLS` | 4 | 单次导入最多调几次模型；4 × 150 = 600 ≥ 500 行上限 |
| `IMPORT_AI_TIMEOUT_MS` | 45000 | 整次请求预算，前端为这一路单独设 60s |
| `IMPORT_AI_USER_LIMIT` | 10 次/小时 | 按用户限流（内存计数，单实例）；不按 IP，避免共享出口互相误伤 |

`MAX_UNKNOWN_WORDS` 默认留空：只有生词容忍生效时，预算才按难度取
（medium 3 / hard 5；easy 恒为 0，md/41）。生词容忍不传时为「自动」：
**最终模式默认开**，其余默认关（md/42）；显式 `true` / `false` 始终优先。
显式设置会把它变成**全局覆盖**，三档压成同一个数，只用于调试与回放对比——
它不能凭空打开开关，开关没开时预算仍是 0。

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
| `node scripts/hash-admin-password.mjs '密码'` | 生成 `ADMIN_PASSWORD_HASH`，只打印可直接粘进 `.env` 的一行（md/37） | 只读，不打印明文 |
| `node scripts/backfill-token-usage.mjs` | 把历史 `readings` / `generationfailures` 的 token 写成 `legacy` 流水；**默认 dry-run**，`--yes` 才写 | 写库；按 `(userId, totalTokens, createdAt)` 判重，可重复执行 |

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
      import/           文件抽取：嗅探 → docx / xlsx / csv / txt / 图片（md/48）
    dictionary/         COCA 词库加载与前缀检索
    readings/           生成编排、分段闭环、校验、判分、历史
    quota/              每日额度：账号 / 设备 / 网络指纹三档计数（md/35）
    budget/             全局免费 token 池：每次模型调用累加，到顶即停（md/36）
    usage/              token 流水（每次模型调用一条，按用户 / 任务 / 天归类，md/37）
    feedback/           用户反馈：用户侧提交 + 管理端回复（md/37）
    admin/              管理员后台：单账号鉴权 + 只读用户台账（md/37）
  tests/                vitest（每个文件独立内存 Mongo）
data/                   词库、三档基础词表、不规则词形、词频排名、OCR 语言模型
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
| 生成 429 `QUOTA_EXCEEDED` | 当天额度用完（账号、设备或网络指纹任一档） | 等北京时间 0 点；`details.scope` 说明是哪一档，`Retry-After` 是到重置的秒数 |
| 生成 503 `FREE_BUDGET_EXHAUSTED` | 全局免费池（`FREE_TOKEN_BUDGET`）用完了 | **不会自己恢复**：加预算（改 `.env` 或调计数器）后重启；`details` 里有上限与已用量 |
| `/api/admin/*` 一律 404 | 没配 `ADMIN_USERNAME` 或 `ADMIN_PASSWORD_HASH` | 生成哈希写进 `.env` 后**重启**；改密码同样要重启（md/37 §2.1） |
| 自备 Key 接口 503 `USER_API_KEY_DISABLED` | `USER_API_KEY_ENABLED=false` 或 `USER_API_KEY_SECRET` 为空 | 跑 `node scripts/gen-user-key-secret.mjs` 填进 `.env` 后重启（md/43 §8） |
| 生成 403 `USER_API_KEY_INVALID` | 生成中途上游拒绝了用户的自备 Key（余额 / 吊销） | 不是登录问题，不会踢回登录页：引导用户去个人中心重新导入；该 Key 已自动标为 `invalid` |
| 任务 `failed` + `USER_API_KEY_MISSING` | 创建时用了自备 Key，执行前被删 / 解不开 | 重新导入 Key 后 `retry`；**不会**悄悄改花免费池（md/43 §6.3） |
| 个人中心显示 `unreadable` | 主密钥换过且旧值没留在 `_PREVIOUS` | 把旧值补到 `USER_API_KEY_SECRET_PREVIOUS` 并重启，或让用户重新导入 |
| 管理端 401 `ADMIN_AUTH_REQUIRED` | 没带管理员令牌 / 过期（12 小时）/ 登出过 | 重新登录；用户令牌与管理端令牌不通用 |
| 管理端登录 429 | 15 分钟内失败 5 次 / 同一 IP | 等窗口结束；成功登录不占配额 |
| 用户反馈 429 `RATE_LIMITED`（`scope=feedback`） | 同一设备当天已提交 5 条 | 明天再来；计数按北京时间自然日 |
| 文件导入 422 `OCR_FAILED`「图片识别未就绪」 | `data/ocr/` 里没有对应语言的模型 | `npm run fetch:ocr`（或按提示设 `OCR_LANG_PATH`）；Word / Excel 不受影响 |
| 文件导入 422 `OCR_FAILED`「图片识别暂时不可用」 | 上一次起 worker 失败，60 秒冷却中 | 等一分钟；持续失败看日志里的 `ocr worker error` |
| 文件导入 422 `OCR_FAILED`「图片尺寸太大」 | 超过 4000 万像素或单边 3 万；文件可能只有几百 KB | 压缩 / 裁剪后再传。这是**解码前**的拦截：一张 20000×20000 的纯白 PNG 只有 380KB，解码却要 1.2GB（md/48 §16） |
| 文件导入 415 `UNSUPPORTED_MEDIA_TYPE` | `.doc` / `.xls` / `.pdf` 等旧格式，或不是 Office 文件 | 按提示另存为 `.docx` / `.xlsx`；txt / csv 直接传 |
| 生成 422 `VOCABULARY_TOO_SMALL` | 已知词不够写这么长（门槛随篇幅走，见 `capacity-table.js` 的 `minKnownFor`） | 缩篇幅或加词；这是预期拦截，不是故障 |
| 任务变成 `failed` + `TASK_INTERRUPTED` | 执行实例失联（重启 / kill -9 / OOM），心跳过期后被回收 | 调 `POST /generate/tasks/:id/retry`：已收下的段会复用，只补失败的段（md/31 §11） |
| 生成 400 `final_mode_locked` | hard 写 601–1000 词，但个人词库不足 3000 | 继续攒词；解锁后上限从 600 抬到 1000（md/30 §2.2） |
| 生成 400 `target_words_cap` | 篇幅超过该难度上限（300 / 450 / 600；hard 已解锁时 1000） | 前端滑块上限读 `/capacity` 的 `levels[level].maxTargetWords` |
| 测试首次跑卡住几分钟 | 正在下载 mongodb-memory-server 二进制 | 等它下完；断网环境需要预置缓存 |
