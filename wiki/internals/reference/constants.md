# 常量字典

全部可调常量集中在 `src/render/truncate.ts` 与 `src/render/shared.ts`。
**改任何一个都必须 bump `GARDEN_VERSION`**（流程：wiki/internals/tasks/tune-budget.md）。

## 预算常量（src/render/truncate.ts）

| 常量 | 值 | 作用域 | 依据 |
|------|----|--------|------|
| `TOOL_RESULT_BUDGET` | 1000 | toolResult 文本、bashExecution 输出 | p50=490；「一屏」原则 |
| `TOOL_ARG_BUDGET` | 800 | toolCall arguments 中的字符串值 | bash 命令 p90=694 |
| `THINKING_BUDGET` | 1000 | thinking 块 | p50=393；同「一屏」 |
| `DETAILS_BUDGET` | 4000 | 保留类 details（如 edit 的 diff） | diff 是实质内容 |
| `CUSTOM_DATA_BUDGET` | 2000 | custom entry 的 data | — |
| `INLINE_LIMIT` | 500 | 任意物理行封顶 | 残留超长行统计 |
| `INLINE_MIN_OMIT` | 64 | 省略量低于此值不截 | marker ≈30 字符，省太少是噪声 |
| `SESSION_NAME_BUDGET` | 100 | session_info 会话名（仅 l1） | 扩展会把首条 prompt 全文拼进名字 |
| 头尾比（默认参数） | 0.6 | 全部截断 | error 行分布均匀，尾部略高 |

详细依据：wiki/internals/concepts/truncation.md。

## 选择器常量（src/session-list.ts）

与渲染无关，不改 `GARDEN_VERSION`。

| 常量 | 值 | 作用域 | 依据 |
|------|----|--------|------|
| `HEAD_READ_BYTES` | 64KB | session jsonl 头部快读 | header + 首条 user 消息几乎总在其中 |
| `FRONTMATTER_READ_BYTES` | 4KB | garden md frontmatter | frontmatter 仅 ~20 行 |
| `FULLTEXT_READ_BYTES` | 1MB | garden l2 正文（搜索语料） | l2 平均 ~20KB，上限防异常大文件 |

## 生成器版本（src/render/shared.ts）

| 常量 | 当前值 | 语义 |
|------|--------|------|
| `GARDEN_VERSION` | `"0.7.2"` | 渲染行为版本。写入 frontmatter `version`；增量判断要求输出文件的 version 与之一致，否则重新生成 |

版本历史：
- `0.2.0` 引入版本标记与 details 丢弃策略
- `0.3.0` line 级截断（6:4 整行）+ thinking 截断
- `0.4.x` inline 级截断、永不硬切、JSON 物理行封顶、`INLINE_MIN_OMIT` 64
- `0.5.0` details 块渲染（diff/patch 不再转义单行，L1 patch 优先去重）；
  l2 turn 编号 + 轮级耗时/output tokens
- `0.6.0` l2：assistant text 全量保留（按序交织，原为只留每轮最后一条）；
  thinking 改为占位段落（原为丢弃）；节标题时间改为轮内首条 assistant
- `0.6.1` l1：session_info 会话名 inline 封顶 100（`SESSION_NAME_BUDGET`；
  pi-ssh-remote 会把首条 prompt 全文拼进名字，实测 242 字符）
- `0.7.0` 新增 l3 级别：l2 基础上每轮只保留最后一段 assistant text
  （thinking 占位 / 中间 text / 工具一行摘要丢弃）——即 0.6.0 前 l2
  「只留每轮最终答复」的行为回归为独立级别，且更进一步去掉工具行。
  l2.ts 引擎抽为 `skeleton.ts`（l2/l3 共用，finalOnly 开关），l2.ts 改为薄封装
- `0.7.1` 标题/标记 emoji 刷新：User 👤→🙋、Assistant 🤖→✨、
  Compaction 🗜️→🔀、Branch Summary/跳回提示 ⑂→🔀、会话命名 📛→🆔
  （🗜️/⑂ 依赖 VS16 或为数学符号，部分终端渲染为暗色文字符号）
- `0.7.2` Compaction 回退 🔀→🗜️：🔀 是「分叉」意象与压缩语义错位；
  候选 🪗 在部分字体缺字形（豆腐块）。语义最准优先，接受其 VS16 渲染风险

## details 丢弃名单（src/render/shared.ts）

`DETAILS_DROP_TOOLS`：`bash` `read` `write` `grep` `ls` `find` `powershell` `glob`

L1 中这些输出型工具的 toolResult.details 被丢弃（纯冗余：内容已在 text 中）。
`edit` 等工具的 details 含独有信息（diff/patch），保留（受 `DETAILS_BUDGET` 截断）。
空 details（null / `{}` / `[]`）任何级别都不渲染。未知工具保守保留。

保留的 details 以块渲染（见 wiki/internals/reference/output-format.md）：
多行字符串值渲染为围栏块（patch 用 ```diff），标量并入头行；
L1 中 patch 存在时跳过等价的 diff 字段。
