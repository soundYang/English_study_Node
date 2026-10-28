# 2026-10-28 首轮付费采样存档

对应 `md/21` §7.1.1。**这是运行结果，不是源码**；放在 `samples/2026-10-28/` 是为了
在下次 `seed-test-fixtures` 清库后仍能复查，`.gitignore` 对 `samples/*` 开了这个目录的例外。

## 环境

| 项 | 值 |
| -- | -- |
| 时间 | 2026-10-28 08:32–08:39 UTC |
| codeVersion | `20dddb8` |
| 生成策略 | `segmented`（默认） |
| 模型 | `deepseek-chat` |
| 基础词表版本 | easy `f9e7079b` / medium `953faf74` / hard `b1812406` |
| 锚点日期 | 2026-10-28 |

## 结果

15 case × 3 = 45 次请求，其中 36 次实际付费：

- 成功 33 / 36 = **91.7%**
- 失败 3 次，均为 `AI_INVALID_RESPONSE`（收尾 detail 题答案与 evidence 重合 < 0.5）
- thin 的 9 次全部被 B 门 `VOCABULARY_TOO_SMALL` 拦下，0 token
- P50 / P95 墙钟 11.4 s / 17.7 s，最慢 20.6 s
- 1,501,563 token，共 **¥0.8706**（平均 ¥0.0242 / 付费次）

## 缺口 1 复验（同日，修复后）

`md/21` W11 缺口 1（分段路径补 `questions` 修正轮）合入后，用同一 fixture
重跑原来失败的 3 条，各 1 次，codeVersion `573b0c6`：

| # | 结果 | 字数 | `repair:questions` | token | 费用 |
| - | ---- | ---- | ------------------ | ----- | ---- |
| 5 | 201 | 425 / 目标 400 | **触发并修好**（18 轮的最后一步） | 51,375 | ¥0.0084 |
| 7 | 201 | 313 / 目标 400 ⚠️ 偏短 | 未触发（首轮题目合格） | 40,777 | ¥0.0067 |
| 8 | 201 | 168 / 目标 200 ⚠️ 偏短 | 未触发（首轮题目合格） | 17,085 | ¥0.0024 |

3 次共 ¥0.0175。`#5` 直接验证了修复路径；`#7/#8` 这次是模型首轮就写了合格题目，
修复轮没有触发（它只在终检判出 `questions` 时调用）。
两条偏短仍是 W11 缺口 2 / 段丢弃问题的现场证据。

## 文件

| 文件 | 内容 |
| ---- | ---- |
| `runs-rich.json` | `fixture-rich` 8 case × 3 的 `batch-generate.mjs` 原始落盘（每轮 token / 字数 / 违规） |
| `runs-full.json` | `fixture-full` 4 case × 3（hard 档） |
| `runs-thin.json` | `fixture-thin` 3 case × 3（闸门用例） |
| `db-snapshot.json` | 采样后库内快照：33 篇成功 `Reading`（含正文、题目、`aiMeta.rounds`）+ 12 条 `GenerationFailure`（含 `finalArticle`） |
| `batch-summary.log` | 当次终端输出：每条用例结果与汇总 |
| `server-3100.log` / `3101` / `3102` | 三个测试实例的 pino 日志（含失败原因与正文 head/tail） |
| `revalidate-gap1-case5/7/8.json` | 缺口 1 修复后的重跑落盘（各 1 次） |
| `server-3100-revalidate.log` | 重跑实例的 pino 日志 |

`runs-*.json` 里没有正文（`batch-generate.mjs` 默认不落 `article`）；正文在 `db-snapshot.json`。

## 复现

```bash
node scripts/seed-test-fixtures.mjs --fixture all --anchor 2026-10-28
RATE_LIMIT_ENABLED=false DEFAULT_USER_ID=fixture-rich PORT=3100 node src/server.js
RATE_LIMIT_ENABLED=false DEFAULT_USER_ID=fixture-thin PORT=3101 node src/server.js
RATE_LIMIT_ENABLED=false DEFAULT_USER_ID=fixture-full PORT=3102 node src/server.js
node scripts/batch-generate.mjs --fixture rich  --base http://127.0.0.1:3100 --times 3
node scripts/batch-generate.mjs --fixture full  --base http://127.0.0.1:3102 --times 3
node scripts/batch-generate.mjs --fixture thin  --base http://127.0.0.1:3101 --times 3
node scripts/summarize-runs.mjs --user fixture-rich --days 0   # 只读汇总
```

⚠️ 复现会真实调用模型并产生费用；`--anchor` 必须与采样当日一致，
否则 `today_new` / `today_reviewed` 两个用例的候选池会变。
