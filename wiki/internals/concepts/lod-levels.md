# LOD 三级输出（l0 / l1 / l2）

garden 把同一个 session 渲染成三级 markdown，类似 LOD（Level of Detail）。
同一时刻、同一份数据，三级各自回答不同的问题。

## 定位

| 级别 | 一句话定位 | 典型用途 |
|------|-----------|---------|
| **l0** | 证据级全量归档 | 需要原文时兜底（diff、完整输出、token 细节）；平时不读 |
| **l1** | 调试与阅读主力 | 复盘 agent 行为、排障、理解「为什么这么干」；体积约为 l0 的 1/3 |
| **l2** | 剧情骨架 | 快速回顾「做了什么」；喂给知识整理的素材；体积约为 l0 的 1/15 |

经验法则：**先读 l2 找剧情，再读 l1 查细节，最后才翻 l0 对原文。**

## 取舍表

| 内容 | l0 | l1 | l2 |
|------|----|----|----|
| user prompt | 全量 | 全量 | 全量（带 turn 编号 `#N`） |
| assistant text | 全量 | 全量 | 全量（按时间序与工具行交织；每轮一个节，标题带轮级耗时/output tokens） |
| thinking | 全量 | 截断（预算 1000） | 占位段落 `**🧠 Thinking**`（内容丢弃） |
| toolCall | args 完整 JSON | args 中超长字符串截断（预算 800） | 一行摘要 `- 🔧 **bash** \`ls\``，报错加 ❌ |
| toolResult | 全量（details 块渲染） | 文本截断（预算 1000）；bash/read/write 等 details 丢弃，edit 的 diff/patch 渲染为围栏块（patch 优先，预算 4000） | 丢弃 |
| compaction / branch_summary | 全量 | 全量 | 保留 summary |
| model_change / label / custom 等 | 保留 | 保留 | 忽略（session 名进 frontmatter） |
| 图片 | 占位符 `*[image: png, 83KB]*` | 占位符 | 丢弃 |

l1 的截断规则细节（6:4、整行、软断行、marker 格式）见
wiki/internals/concepts/truncation.md；输出格式的逐字段定义见
wiki/internals/reference/output-format.md。

## 为什么 thinking 在 l1 是截断而不是丢弃

l0 体积太大（单 session 可达 1MB+），人类几乎不会去翻；调试 agent 决策实际从 l1 开始。
因此 thinking 在 l1 保留头尾（推理的开头是问题理解、结尾是计划，中间是探索），
l2 才彻底丢弃。——2026-09-14 决策。
