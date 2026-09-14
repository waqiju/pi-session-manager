# Handoff: L1 优化回顾与下一步优化方向

- 日期：2026-09-14
- 项目：garden（pi-session-manager）
- 状态：供零上下文读者接手；对应代码状态 `GARDEN_VERSION = 0.4.3`

## 1. 背景

pi 的 session 记录是 `.jsonl`（机器格式、人类阅读困难）。garden 把它转为三级 markdown：

- **l0**：≈1:1 全量归档
- **l1**：可读日志 —— 机械截断（inline 级 + line 级）
- **l2**：骨架 —— user prompt + 每轮最后答复 + 工具一行摘要 + compaction/branch summary

各级渲染规则见 [lod-levels](wiki/internals/concepts/lod-levels.md)、
[truncation](wiki/internals/concepts/truncation.md)；
预算常量在 `src/render/truncate.ts`，调整流程见 [tune-budget](wiki/internals/tasks/tune-budget.md)。

## 2. 这几轮已完成的优化（按时间顺序）

| 轮次 | 内容 | 效果（单个检查 session，l0 1.27MB） |
|---|---|---|
| 1 | L1 丢弃输出型工具（bash/read/write…）的冗余 details，edit 的 diff/patch 保留；空 details 不渲染 | 全量数据约 -7.5MB（-11%） |
| 2 | line 级截断：6:4 头尾预算、整行 greedy、跨界行完整保留（宁多不少）；marker 改英文 `... (omitted X chars / Y lines) ...`；thinking 从「全量」改为截断保留（用户要求，L1 是调试 thinking 的起点） | l1 533KB |
| 3 | inline 级截断：行 > 500 封顶；**永不硬切**（head 向后、tail 向前找分隔符，找不到整行保留）；`truncateEachLine` 封顶 JSON.stringify 转义合并出的物理行（实测最长 4254→有界）；`INLINE_MIN_OMIT=64`（省不够一个 marker 就不截） | l1 467KB，最长行 624 |

测试：`test/truncate.test.ts`（inline+line 单测）、`test/render.test.ts`（渲染断言）、
`test/cli.test.ts`（端到端含增量与版本刷新）。当前 27 个测试全过。

## 3. 已确认的决策

- **永不硬切**：无分隔符的行整行保留（宁多不少贯彻到底）
- **thinking 在 L1 保留但截断**（预算 1000）—— 用户理由：l0 太庞大没人看，调试 thinking 从 l1 开始
- **预算常量**：`TOOL_RESULT=1000`、`TOOL_ARG=800`、`THINKING=1000`、`DETAILS=4000`、`INLINE_LIMIT=500`
- **隐藏目录不参与**：递归扫描时跳过 `.mono` 等点开头目录（用户决策）
- **edit diff 可读性渲染**：已批准，放入下轮调查一起讨论（当前 details 是转义 JSON 单行）

## 4. 下一步优化方向（按推荐优先级）

### ① 可发现性：garden 索引（推荐先做）⭐

痛点已从「单文件太大」变成「几百个 session 不知道哪个讲了什么」。建议：

```
garden/index.md            # 全局：按项目分组
garden/<subdir>/index.md   # 每项目：每个 session 一行
```

每行：时间、session 名、首条 user 消息前 80 字符、轮数、token、指向 l2 的相对链接。
成本低（解析时顺手收集），且是 knowledge-organize skill 的天然入口。

### ② 按价值分配预算（L1 微调）

统一预算不区分价值密度：

- **isError 的 toolResult 预算加倍**（1000→2500）：报错全文对调试最有价值；占比极小
  （>1200 字符的块中 isError 仅 141/7295 ≈ 2%），成本几乎为零
- **bash 结果预算 1000→800，read 保持 1000**：bash 多为探索性输出（数据：bash 11.9MB vs read 5.3MB），
  read 内容更可能被后续引用

预计再省 2~3MB，同时**提升**关键信息保留。

### ③ pi 接入（原定路线图）

CLI 已验证稳定。自然的下一步：

- pi 扩展在 session 结束/compaction 后调用 `processFile()`（cli.ts 已导出）
- 或 watch 模式（fs.watch sessions 目录，防抖触发增量转换）

### ④ L2 可读性增强（属于此前 defer 的 block 级方向）

- 连续同类工具行折叠：`read /docs/* ×12`
- turn 编号、每轮耗时/token

### ⑤ edit diff 可读性渲染（已批准，下轮调查）

details 里的 diff/patch 现在是转义 JSON 单行，可改为多行 diff 文本块渲染，与截断正交。

## 5. 挂起事项

- **嵌套目录递归扫描**：用户决策为「递归 + 隐藏目录不参与」。但调查发现 67 个嵌套 jsonl
  全部在 `--mnt-d-1_Workspace-bot--/1_archived/--mnt-d-1_Workspace-bot--/`（手工归档副本，非隐藏目录），
  且内容在主目录已有。建议改走**方案 A：保持不递归**（pi 自身只写一层结构，嵌套只来自手工归档）。
  待用户拍板。
- **检查文件**：`~/.pi/agent/garden/--mnt-d-1_Workspace-bot_home--/2026-09-05T15-04-09-626Z_....l1.md`
  是这几轮优化的抽查样本（l1 467KB，最长行 624）。

## 6. 复现与验证

```bash
npm test                       # 27 个测试
node src/cli.ts                # 全量转换（版本不匹配时自动全量重生成）
node src/cli.ts <xxx.jsonl>    # 单文件
```
