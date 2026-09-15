# LOD 四级输出（l0 / l1 / l2 / l3）

garden 把同一个 session 渲染成四级 markdown，类似 LOD（Level of Detail）。
同一时刻、同一份数据，四级各自回答不同的问题。

## 定位

| 级别 | 一句话定位 | 典型用途 |
|------|-----------|---------|
| **l0** | 证据级全量归档 | 需要原文时兜底（diff、完整输出、token 细节）；平时不读 |
| **l1** | 调试与阅读主力 | 复盘 agent 行为、排障、理解「为什么这么干」；体积约为 l0 的 1/3 |
| **l2** | 剧情骨架 | 快速回顾「做了什么」（含工具轨迹）；体积约为 l0 的 1/15 |
| **l3** | 纯问答对话 | 只看「问了什么 → 结论是什么」；喂知识整理的素材 |

经验法则：**先读 l3/l2 找剧情，再读 l1 查细节，最后才翻 l0 对原文。**

默认只导出 **l1 + l3**（2026-09-15 决策：l0 与源 jsonl 冗余、l2 语料与 l3 重叠，
四级全导磁盘占用 ~3.5 倍）。可用 `PI_GARDEN_LEVELS`（扩展）或 `--levels`（CLI）
调整；`/gardener-open lN` 指定未导出的级别时会按需只生成该级别。

## 取舍表

| 内容 | l0 | l1 | l2 | l3 |
|------|----|----|----|----|
| user prompt | 全量 | 全量 | 全量（带 turn 编号 `#N`） | 同 l2 |
| assistant text | 全量 | 全量 | 全量（按时间序与工具行交织；每轮一个节，标题带轮级耗时/output tokens） | 每轮只留最后一段 text（节标题与统计同 l2） |
| thinking | 全量 | 截断（预算 1000） | 占位段落 `**🧠 Thinking**`（内容丢弃） | 丢弃（连占位也没有） |
| toolCall | args 完整 JSON | args 中超长字符串截断（预算 800） | 一行摘要 `- 🔧 **bash** \`ls\``，报错加 ❌ | 丢弃（❌ 报错标记随之消失，去 l1/l2 查） |
| toolResult | 全量（details 块渲染） | 文本截断（预算 1000）；bash/read/write 等 details 丢弃，edit 的 diff/patch 渲染为围栏块（patch 优先，预算 4000） | 丢弃 | 丢弃 |
| compaction / branch_summary | 全量 | 全量 | 保留 summary | 同 l2 |
| model_change / label / custom 等 | 保留 | 保留 | 忽略（session 名进 frontmatter） | 同 l2 |
| 图片 | 占位符 `*[image: png, 83KB]*` | 占位符 | 丢弃 | 丢弃 |

l1 的截断规则细节（6:4、整行、软断行、marker 格式）见
wiki/internals/concepts/truncation.md；输出格式的逐字段定义见
wiki/internals/reference/output-format.md。

## 为什么 thinking 在 l1 是截断而不是丢弃

l0 体积太大（单 session 可达 1MB+），人类几乎不会去翻；调试 agent 决策实际从 l1 开始。
因此 thinking 在 l1 保留头尾（推理的开头是问题理解、结尾是计划，中间是探索），
l2 才彻底丢弃。——2026-09-14 决策。

## l3 取舍规则（2026-09-14 决策）

l3 = l2 基础上，agent 回复每轮只保留最后一段 text。这是 0.6.0 之前 l2
「只留每轮最终答复」行为的回归（见 wiki/internals/reference/constants.md 版本历史），
且更激进：连 thinking 占位与工具一行摘要也去掉。

- 「最后一段」= 轮内向前找最近的 assistant text：最后一条 assistant 消息
  只有 toolCall 时，取轮内更早消息的 text
- 轮内完全没有 assistant text（纯工具轮、被 abort、只有用户的 `!!` bashExecution）
  → assistant 节整体省略；有轮级统计则退化为独立 meta 行 `> ⏱ 45s · out 5.3k`
- assistant 节标题与轮级统计（⏱ 耗时 / out tokens）和 l2 完全一致
  （时间 = 轮内首条 assistant），便于跨级别对照
- l3 没有工具行，l2 的 ❌ 报错标记在 l3 不存在——报错细节去 l1/l2 查
