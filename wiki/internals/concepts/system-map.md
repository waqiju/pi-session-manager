# 系统地图（garden 全景）

garden 是单向的格式转换器：pi 的 session jsonl → 四级 markdown 归档。无服务端、无状态、可重复运行（幂等 + 增量）。

## 全景

```
┌────────────────────────────────────────────────────────────┐
│ pi (coding agent)                                          │
│   持续追加 ~/.pi/agent/sessions/--<cwd 转义>--/*.jsonl      │
│      │                                                     │
│      └─ extensions/garden.ts（pi 扩展，会话事件触发）        │
│         session_start / agent_settled(防抖) /              │
│         session_compact / session_shutdown / /garden       │
└────────────────────────────────────────────────────────────┘
                     │  （sessions 在本机是软链 → /mnt/d/sd/_pi/sessions）
                     ▼
┌────────────────────────────────────────────────────────────┐
│ garden 转换核心（src/cli.ts，CLI 与扩展共用）                │
│                                                            │
│   collectJobs    扫描 sessions 目录（子目录/*.jsonl，一层） │
│   prepareGroup   按子目录分组：全量解析 + naming.ts 命名    │
│                  计划（日期-序号-slug，序号是组内全局属性）  │
│   processFile    每个 session:                              │
│     parser.ts          jsonl → { header, entries }          │
│     render/l0.ts  ─┐                                        │
│     render/l1.ts   ├→ render/full.ts（L0/L1 共用引擎，       │
│                    │    差异仅是截断开关）                   │
│                    │    截断逻辑：render/truncate.ts         │
│     render/l2.ts  ─┤                                        │
│     render/l3.ts   ┘→ render/skeleton.ts（L2/L3 共用引擎，   │
│                         差异是 finalOnly 开关）              │
│   增量判断 isUpToDate：输出 mtime ≥ 源 且 frontmatter        │
│   version == GARDEN_VERSION                                 │
│   旧文件清理 removeStaleOutputs：改名/序号漂移后按            │
│   frontmatter session_id 匹配删除同 session 的旧文件         │
└────────────────────────────────────────────────────────────┘
                     ▼
┌────────────────────────────────────────────────────────────┐
│ ~/.pi/agent/garden/--<cwd 转义>--/<日期>-<序号>-<slug>.     │
│   {l0,l1,l2,l3}.md + index.md（fork 森林索引）；目录结构    │
│   镜像 sessions                                            │
└────────────────────────────────────────────────────────────┘
```

## 模块职责

| 模块 | 职责 |
|------|------|
| `extensions/garden.ts` | pi 扩展适配层：转换事件接线、`/garden` 快速选择器接线、`/gardener-output`、`/gardener-open`；逻辑全部委托 src/ |
| `extensions/garden-selector.ts` | `/garden` 自绘选择器组件：零 realpathSync（内建组件在 drvfs 上卡 ~22s 的根因绕过）；零运行时 pi 依赖，node --test 可直测 |
| `extensions/garden-clipboard.ts` | 选择器 Ctrl+Y 子树复制：自解释文本 + 平台剪贴板命令 |
| `extensions/garden-files.ts` | 选择器删除操作：jsonl（trash 优先）+ garden md 产物清理 |
| `src/session-list.ts` | `/garden` 选择器与 index.md 的数据源：只读 garden md（frontmatter + 正文），不读 jsonl（见 wiki/internals/reference/extension.md） |
| `src/session-tree.ts` | 选择器/索引纯逻辑：fork 树（按 jsonl 文件名配对，零 syscall）+ 搜索（fuzzy / 短语 / 正则） |
| `src/index-page.ts` | garden 目录索引 index.md 生成：fork 森林 + 相对链接嵌套列表；CLI 与扩展命令共用 |
| `src/reverse-sync.ts` | 反向同步：人工编辑的 index.md（换父缩进 / to-delete / to-archive）对账并应用回 sessions；见 [reverse-sync](reverse-sync.md) |
| `src/format.ts` | 会话展示格式化（nodeLabel / formatSizeLabel / formatDate），index.md 与子树复制共用 |
| `src/textwidth.ts` | 终端文本宽度工具（ANSI 零宽 / CJK 宽字符 / 按列截断），供选择器渲染 |
| `src/open.ts` | gardener-open：级别选择、平台检测、打开命令 |
| `src/cli.ts` | 参数、目录扫描、命名计划、旧文件清理、增量判断、写盘 |
| `src/naming.ts` | 输出文件命名：本地日期 + 组内序号 + slug（session_info.name → untitled 兜底） |
| `src/parser.ts` | jsonl → Entry[]；容忍 append 到一半的残缺末行 |
| `src/types.ts` | session-format v3 的全部 entry / message 类型 |
| `src/render/full.ts` | L0/L1 渲染引擎：按文件顺序忠实渲染所有 entry |
| `src/render/l0.ts` `l1.ts` | 薄封装：renderFull + level 开关 |
| `src/render/l2.ts` `l3.ts` | 薄封装：renderSkeleton + level 开关 |
| `src/render/skeleton.ts` | L2/L3 骨架引擎：user prompt 全量 + assistant text（l2 全量交织 / l3 每轮只留最终答复）+ 工具一行摘要（仅 l2） |
| `src/render/truncate.ts` | 截断（inline 级 + line 级）与全部预算常量 |
| `src/render/shared.ts` | frontmatter、统计、围栏、分支提示、`GARDEN_VERSION` |

## 关键设计点

- **tree → 线性**：session entry 经 `id/parentId` 组成树，但渲染不做树重建，
  按文件 append 顺序输出；`parentId` 不是上一条时插入 `> 🔀 跳回分支点` 提示
  （理由与细节见 wiki/internals/concepts/session-format.md）。
- **L0/L1 共用引擎**：两者差异只是截断开关（`truncate` 布尔），避免两份渲染逻辑漂移。
- **L2/L3 共用引擎**：差异只是 finalOnly 开关（l3 每轮只留最后一段 assistant text），
  与 L0/L1 同一模式。
- **增量语义**：session 是 append-only，源文件变新才重生成；渲染逻辑变更靠
  `GARDEN_VERSION` bump 触发全量重生成（流程见 wiki/internals/tasks/tune-budget.md）。

## 已知限制

- `collectJobs` 只扫一层子目录；sessions 下的嵌套目录（如 `.mono/`，约 67 个文件）
  不会被转换（2026-09-14 发现，待决策是否递归）。
- 同一目录出现两个 session id 相同的 jsonl 时（pi 实际不会产生），旧文件清理可能
  误删对方输出（清理只按 frontmatter session_id 匹配）。
- 扩展只转换**当前会话**的文件；全量回填用 CLI 或 `/gardener-output all`。
- `/garden` 选择器以 garden md 为唯一数据源：未转换的 session 不出现在列表中
  （升级后跑一次 `/gardener-output all` 回填；旧版产物缺 `source` 字段的同样跳过）。
- 反向同步（Ctrl+G）只对 current scope 生效（index.md 是项目级文件）；label 文本改动
  不生效（身份只认 href）。
- 未来方向（未实现）：watch 模式（脱离 pi 生命周期的独立守护）。
