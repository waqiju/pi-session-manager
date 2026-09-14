# pi-session-manager

简称：garden

把 pi 的 session 记录（`~/.pi/agent/sessions/**/*.jsonl`，人类阅读困难）转换为三级 markdown 文档，输出到与 sessions 同级的 `garden/` 目录。

## 环境要求

- Node.js >= 22.18（利用原生 type-stripping 直接运行 `.ts`，无构建步骤、零依赖）

## 使用

```bash
node src/cli.ts                    # ~/.pi/agent/sessions → ~/.pi/agent/garden
node src/cli.ts <sessions目录>     # 输出到其同级 garden/
node src/cli.ts <xxx.jsonl>        # 单文件模式
node src/cli.ts ... -o <输出目录>  # 自定义输出
```

`npm link` 之后可直接用 `garden` 命令。

- 输出目录镜像 sessions 的子目录结构：`garden/--mnt-d-xxx--/<session>.l0.md`
- 增量转换：源文件 mtime 比输出新才重新生成（session 是 append-only，会话进行中说会重新生成）

## 三级 LOD

| 内容 | l0（≈1:1） | l1（瘦身） | l2（骨架） |
|---|---|---|---|
| user prompt | 全量 | 全量 | 全量 |
| assistant text | 全量 | 全量 | 每轮最后一条含 text 的 assistant 消息 |
| thinking | 全量 | line 截断（预算 1000） | 丢弃 |
| toolCall | args 完整 JSON | args 中超长字符串 line 截断（预算 800） | 一行摘要 `- 🔧 **bash** \`ls\``，报错加 ❌ |
| toolResult | 全量（含 details） | 文本 line 截断（预算 1000）；bash/read/write 等的 details 丢弃（与 text 冗余），edit 的 diff 保留（预算 4000） | 丢弃 |
| compaction / branch_summary | 全量 | 全量 | 保留 summary |
| model_change / label / custom 等 | 保留 | 保留 | 忽略（session 名进 frontmatter） |
| 图片 | 占位符 | 占位符 | 丢弃 |

### 截断规则（l0 → l1）：inline 级 + line 级

两层流水线：`原始文本 → 逐行 inline 截断 → 块级 line 截断`

**inline 级（行内）**：
- 任何一行 > 500 字符 → `<head> ... (omitted X chars) ... <tail>`（6:4，即头 300 / 尾 200）
- **永不硬切**：head 向后、tail 向前找最近的空白/逗号再断；找不到分隔符的行整行保留（宁多不少）
- 省略量 < 64 字符不截（至少省出一个 marker 的量级，否则只增噪声）

**line 级（块）**：
- 块 ≤ 预算：直接保留（但其中的超长行已被 inline 截断）
- 否则按 **6:4** 分头/尾预算，从两端 greedy 拿**整行**，跨界行完整保留（宁多不少）
- 头尾行数重叠时返回原文（不做无意义截断）
- 中间插入标记：`... (omitted X chars / Y lines) ...`
- 预算常量在 `src/render/truncate.ts`：`TOOL_RESULT_BUDGET=1000`、`TOOL_ARG_BUDGET=800`、`THINKING_BUDGET=1000`、`DETAILS_BUDGET=4000`、`INLINE_LIMIT=500`。调整后 bump `GARDEN_VERSION`（`src/render/shared.ts`），下次运行自动全量重生成

- 每份 md 带 YAML frontmatter：session id、cwd、起止时间、会话名、模型、消息计数、token/成本汇总
- 分支（tree 结构）不做重建，按文件顺序渲染；`parentId` 跳回时插入 `> ⑂ 跳回分支点 <id>` 提示

## 开发

```bash
npm test    # node --test，fixture 覆盖全部 entry 类型 + 分支 + compaction
```

目录结构：

```
src/
  cli.ts          # 入口：参数、扫描、增量判断
  parser.ts       # jsonl → Entry[]（容忍追加到一半的末行）
  types.ts        # session-format v3 类型
  render/
    shared.ts     # frontmatter、围栏、分支提示、GARDEN_VERSION
    truncate.ts   # inline 级 + line 级截断（6:4 整行 greedy + 行内封顶）+ 预算常量
    full.ts       # L0/L1 引擎（差异仅是截断开关）
    l0.ts l1.ts   # 薄封装
    l2.ts         # 骨架渲染
test/
  sample.ts         # 构造 fixture
  render.test.ts    # 渲染断言
  truncate.test.ts  # 截断算法单测（inline + line）
  cli.test.ts       # 端到端（含增量、版本刷新）
```
