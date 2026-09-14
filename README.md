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
| thinking | 全量 | 全量 | 丢弃 |
| toolCall | args 完整 JSON | args 中 >2000 字符的字符串头尾截断 | 一行摘要 `- 🔧 **bash** \`ls\``，报错加 ❌ |
| toolResult | 全量 | 头 1500 + 尾 500，中间 `... (省略 N 字符) ...` | 丢弃 |
| compaction / branch_summary | 全量 | 全量 | 保留 summary |
| model_change / label / custom 等 | 保留 | 保留 | 忽略（session 名进 frontmatter） |
| 图片 | 占位符 | 占位符 | 丢弃 |

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
    shared.ts     # frontmatter、截断、围栏、分支提示
    full.ts       # L0/L1 引擎（差异仅是截断开关）
    l0.ts l1.ts   # 薄封装
    l2.ts         # 骨架渲染
test/
  sample.ts       # 构造 fixture
  render.test.ts  # 渲染断言
  cli.test.ts     # 端到端（含增量）
```
