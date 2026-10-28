# 本地词库数据说明

本目录的 `dictionary/a.json` … `dictionary/z.json` 是前端离线词库，由 `scripts/build-dictionary.mjs`
从 COCA 词频表生成。页面运行时不访问任何外部接口，全部数据随前端打包。

同目录另有三个生成物，本文件第 5 节单独说明：`basic-words.json`、`word-ranks.json`、`irregular-forms.json`。

## 1. 数据来源

| 项目     | 内容                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 上游仓库 | <https://github.com/llt22/coca-vocabulary-20000>                                   |
| 上游许可 | MIT（**仅覆盖代码**，词条释义抓取自 91dict / 柯林斯 / 朗文，原始版权不归上游所有） |
| 词表依据 | COCA（美国当代英语语料库）词频，排名越小越高频                                     |
| 抓取日期 | 2026-10-27                                                                         |
| 生成脚本 | `scripts/build-dictionary.mjs`                                                     |

**使用范围**：个人学习项目自用。若将来商用或公开发布，必须替换为有明确授权的词库
（如 Oxford / Merriam-Webster 的商业授权，或 CC 协议词典），否则存在版权风险。

## 2. 文件结构

按词头首字母分成 26 个文件，页面在用户输入首字母时才加载对应分片：

```json
[
  [
    "abandon",
    "/əˈbændən/",
    "/əˈbændən/",
    [
      ["vt.", "放弃，抛弃；离弃，丢弃"],
      ["n.", "放任，放纵"]
    ]
  ]
]
```

每条是 4 元组：

| 下标 | 字段       | 类型                 | 说明                                                             |
| ---- | ---------- | -------------------- | ---------------------------------------------------------------- |
| 0    | `headword` | `string`             | 词头，保留原始大小写                                             |
| 1    | `uk`       | `string \| null`     | 英式音标，已包成 `/.../`；无数据时为 `null`                      |
| 2    | `us`       | `string \| null`     | 美式音标，同上                                                   |
| 3    | `senses`   | `[string, string][]` | `[词性, 中文释义]`，同一词性的多个义项用 `；` 连接；可能为空数组 |

**数组顺序即 COCA 词频顺序**，索引越小越高频。搜索排序直接依赖这个顺序，不要重排。

## 3. 数据规模与已知缺口

| 指标           | 数值                                                    |
| -------------- | ------------------------------------------------------- |
| 词条总数       | 17,631（含人工补的 `an` / `yourselves`）                |
| 分片总体积     | 2.23 MB（gzip 约 0.91 MB）                              |
| 最大分片       | `s.json`，2,062 词 / 275 KB / gzip 115 KB               |
| 无音标         | 506 条，UI 显示 `—`                                     |
| 无释义         | 211 条（多为 `All-American` 这类专有名词），UI 显示 `—` |
| 词性与释义缺失 | 约 157 条只有释义没有词性，`pos` 为空串，UI 不渲染词性  |

源列表本身存在重复：20,195 条里 2,566 条是同一单词在不同排名重复出现（如 `in` 出现在
第 6/128/3038/13656 名），其释义完全一致。构建时按词头小写去重，保留最小排名。

## 4. 重新构建

源数据（约 5.5 MB）不放进本仓库，单独放在与本仓库**同级**的 `coca-vocabulary/` 目录，
需要时按下面步骤重新获取：

```bash
# 1. 下载并解压，只要 vocabulary 目录，落到仓库同级的 coca-vocabulary/
curl -sSL -o repo.tar.gz https://codeload.github.com/llt22/coca-vocabulary-20000/tar.gz/refs/heads/main
mkdir -p ../coca-vocabulary-tmp
tar -xzf repo.tar.gz -C ../coca-vocabulary-tmp --strip-components=1 coca-vocabulary-20000-main/vocabulary
mv ../coca-vocabulary-tmp/vocabulary ../coca-vocabulary
rm -rf ../coca-vocabulary-tmp repo.tar.gz

# 2. 回到仓库根目录，生成分片
node scripts/build-dictionary.mjs
```

脚本默认先找 `../coca-vocabulary`，找不到再退回旧的 `scripts/vendor/coca-vocabulary`；
放在其他位置时用 `--src <目录>` 指定。

脚本会打印条目数、去重丢弃数、缺音标/缺释义条数与各分片体积，用于核对数据是否变化。

## 5. 同目录的其他数据文件

| 文件                    | 用途                                                       | 生成方式                                  |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| `dictionary/*.json`     | 查词与加词的离线词库，17,419 条可检索                      | `scripts/build-dictionary.mjs`            |
| `basic-words.json`      | 生成文章时的基础词白名单（600 个 = 功能词 179 + 高频实词 421，人工筛选） | 见 `md/04_基础词库_600词候选清单.md`；**不是** `build-basic-words.mjs` 的直接产物 |
| `word-ranks.json`       | COCA 词频排名（17,629 条），写入 `Word.cocaRank`、选池时按难度排序 | `scripts/build-word-ranks.mjs`，源数据同 `dictionary` |
| `irregular-forms.json`  | 词形还原用的不规则变化表（约 238 条），词汇校验依赖它      | 手工维护                                  |

四者不会自动同步：词库扩容后，`basic-words.json` 与 `word-ranks.json` 都要单独重跑。
`word-ranks.json` 必须从 `coca-vocabulary` 源数据生成——`dictionary/*.json` 在按首字母
切分时已经丢失了跨字母的绝对排名，反推出来的难度分级会完全失真。
星期与月份名不在 COCA 源里，校验时由 `src/modules/readings/calendar-words.js` 单独放行。
