# 输出格式字典

garden 生成的 markdown 的完整格式约定。面向：阅读者、后续处理脚本（如知识整理）。

## 文件命名与位置

```
<garden根目录>/<sessions子目录名>/<本地日期>-<序号>-<slug>.<level>.md
```

例：`2026-08-31-002-禁用进程-CPU占用高.l1.md`

- **本地日期**：session 开始时间（header timestamp）按运行机器本地时区取
  `YYYY-MM-DD`（人按本地时间回忆会话；frontmatter 里的 `started` 仍是 UTC）
- **序号**：同一子目录内按日期分组，组内按开始时间升序，从 `001` 起（3 位 pad）。
  编号是组内全局属性：插入更早的 session 会使后续序号漂移（文件改名）
- **slug**：最后一条 `session_info.name`（用户可多次 `/name`，last wins）；
  无 → `untitled`。空白与文件系统非法字符压为 `_`，尾部 `.` 去掉，最长 40 字符
- `level` ∈ `l0` / `l1` / `l2` / `l3`。目录结构镜像 sessions

改名或序号漂移时旧文件会成为孤儿：写入前按 frontmatter `session_id` 匹配删除
同 session 的旧命名文件（只读旧文件前 2KB）。源 jsonl 已删除的孤儿输出不删
（归档语义）。实现：`src/naming.ts`（命名）+ `src/cli.ts`（清理）。

## frontmatter（YAML，每份文件开头）

| 字段 | 类型 | 说明 |
|------|------|------|
| `level` | string | `"l0"` / `"l1"` / `"l2"` / `"l3"` |
| `session_id` | string | session UUID |
| `cwd` | string | session 工作目录 |
| `started` / `ended` | string | ISO 时间戳（ended = 最后一条 entry 的时间） |
| `name` | string | 可选。session 名（`/name` 或扩展设置） |
| `models` | string[] | 出现过的模型（assistant 消息与 model_change，去重保序） |
| `messages` | map | 各 role 消息计数，如 `user: 9`、`assistant: 116` |
| `tokens` | map | `input` / `output` / `cache_read` / `cache_write` / `total`（含 compaction/branch_summary 的 usage） |
| `cost_total` | number | 成本合计（4 位小数） |
| `source` | string | 源 jsonl 文件名 |
| `generator` | string | 固定 `"garden"` |
| `version` | string | `GARDEN_VERSION`；增量判断依据 |

## 节标题（l0 / l1）

| 形态 | 含义 |
|------|------|
| `## 🙋 User · HH:MM:SS` | 用户消息 |
| `## ✨ Assistant · HH:MM:SS · <model>` | assistant 消息 |
| `## 🔧 Tool Result · <tool> · HH:MM:SS` | 工具返回；出错时行尾加 `❌` |
| `## 💻 Bash · HH:MM:SS` | bashExecution 消息（`!!` 等） |
| `## 🗜️ Compaction · HH:MM:SS` | 压缩点（summary 全量 + tokensBefore 等元信息） |
| `## 🔀 Branch Summary · HH:MM:SS` | 分支总结 |
| `## 📦 Custom (<customType>) · HH:MM:SS` | custom entry（JSON data） |
| `## 📎 Custom Message (<customType>) · HH:MM:SS` | 扩展注入的消息 |
| `## ❓ 未知 entry (<type>)` | 哨兵：遇到了不认识的类型（跟进：wiki/internals/tasks/add-entry-type.md） |

时间为 UTC `HH:MM:SS`（取自 entry.timestamp，稳定、无时区漂移）。

## 行级标记（l0 / l1）

| 形态 | 含义 |
|------|------|
| `> 🔄 模型切换 → **provider/model** · time` | model_change |
| `> 🧠 thinking level → **high** · time` | thinking_level_change |
| `> 🆔 会话命名：**name** · time` | session_info（l1 中 name 超长时 inline 截断，预算 `SESSION_NAME_BUDGET`=100） |
| `> 🏷️ 标记 \`<targetId>\`：**label** · time` | label |
| `> 🔀 跳回分支点 \`<id>\`` / `> 🔀 回到会话起点` | 分支跳回（parentId ≠ 上一条 id） |
| `> ⚠️ stopReason: \`aborted\` — ...` | assistant 非正常结束（error/aborted） |

assistant 消息内：`thinking` 渲染为 `**🧠 Thinking:**` + 围栏代码块；
`toolCall` 渲染为 `**🔧 \`<name>\`** (\`<id>\`)` + args 的 JSON 围栏块。

## 截断标记

| 形态 | 含义 |
|------|------|
| `... (omitted X chars / Y lines) ...` | line 级截断（独占一行段） |
| `... (omitted X chars) ...` | inline 级截断（行内） |

规则细节见 wiki/internals/concepts/truncation.md。

## 其他约定

- 图片一律渲染为占位符：`*[image: image/png, 83KB]*`
- 代码围栏自适应：内容含 ``` 时自动升级为更多反引号，markdown 不会炸
- toolResult 的 details：L1 丢弃输出型工具（名单见 wiki/internals/reference/constants.md）；
  保留的 details 按字段分形态渲染：
  - 多行字符串值（典型：edit 的 `diff`/`patch`）→ 围栏块（真实换行，非转义 JSON 单行），
    `patch` 用 ```diff 高亮，其余用 ```text
  - 嵌套对象/数组 → JSON 围栏块；标量并入头行 `**details:** (firstChangedLine: 31)`
  - L1 去重：`patch` 存在时跳过等价的 `diff`（同一修改的两种表示；
    diff 的绝对行号仍可翻 l0）

## l2 结构差异

- 只含：frontmatter、user prompt（全量）、assistant text（全量，按时间序与
  工具行交织）、thinking 占位段落、
  工具一行摘要（`- 🔧 **<tool>** \`<detail>\``，报错行尾加 ❌）、
  compaction / branch_summary 的 summary、分支提示
- user 节标题带 turn 编号：`## 🙋 User · #N · HH:MM:SS`（compaction 不重置）
- assistant 节标题带轮级统计：`## ✨ Assistant · HH:MM:SS · <model> · ⏱ 45s · out 5.3k`
  - 耗时 = 轮内最后一个 assistant/toolResult/bashExecution − user 消息起点（墙钟，不含轮间间隔）
  - `out` = 轮内 assistant usage.output 求和（紧凑格式：300 / 5.3k / 1.2M）；无 usage 不显
  - 一轮无含 text 的 assistant 时，统计退化为独立行 `> ⏱ 45s · out 5.3k`
- 工具摘要 detail：bash 取命令首行；read/write/edit 取 path；其余取 JSON 摘要；
  超 80 字符截断
- 无 thinking 内容（只留占位段落 `**🧠 Thinking**`）、无 toolResult 内容、无图片

## l3 结构差异

在 l2 骨架基础上进一步精简为「纯问答对话」（2026-09-14 决策）：

- 每轮只保留最后一段 assistant text；thinking 占位、中间 text、
  工具一行摘要（含 ❌ 报错标记）全部丢弃
- 「最后一段」= 轮内向前找最近的 assistant text（最后一条 assistant 消息
  只有 toolCall 时取更早的 text）
- assistant 节标题与轮级统计和 l2 完全一致（时间 = 轮内首条 assistant，
  便于跨级别对照）
- 轮内无 assistant text（纯工具轮 / abort / 仅 bashExecution）→ assistant 节
  整体省略；有统计则退化为独立行 `> ⏱ 45s · out 5.3k`
- user 节（带 turn 编号）、compaction / branch_summary summary、分支提示同 l2
