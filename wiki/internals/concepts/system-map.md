# 系统地图（garden 全景）

garden 是单向的格式转换器：pi 的 session jsonl → 三级 markdown 归档。无服务端、无状态、可重复运行（幂等 + 增量）。

## 全景

```
┌────────────────────────────────────────────────────────────┐
│ pi (coding agent)                                          │
│   持续追加 ~/.pi/agent/sessions/--<cwd 转义>--/*.jsonl      │
└────────────────────────────────────────────────────────────┘
                     │  （sessions 在本机是软链 → /mnt/d/sd/_pi/sessions）
                     ▼
┌────────────────────────────────────────────────────────────┐
│ garden CLI（src/cli.ts）                                    │
│                                                            │
│   collectJobs    扫描 sessions 目录（子目录/*.jsonl，一层） │
│   processFile    每个 session:                              │
│     parser.ts          jsonl → { header, entries }          │
│     render/l0.ts  ─┐                                        │
│     render/l1.ts   ├→ render/full.ts（L0/L1 共用引擎，       │
│                    │    差异仅是截断开关）                   │
│                    │    截断逻辑：render/truncate.ts         │
│     render/l2.ts  ─┘   骨架渲染（独立实现）                  │
│   增量判断 isUpToDate：输出 mtime ≥ 源 且 frontmatter        │
│   version == GARDEN_VERSION                                 │
└────────────────────────────────────────────────────────────┘
                     ▼
┌────────────────────────────────────────────────────────────┐
│ ~/.pi/agent/garden/--<cwd 转义>--/*.l0.md / .l1.md / .l2.md │
│   目录结构镜像 sessions                                     │
└────────────────────────────────────────────────────────────┘
```

## 模块职责

| 模块 | 职责 |
|------|------|
| `src/cli.ts` | 参数、目录扫描、增量判断、写盘 |
| `src/parser.ts` | jsonl → Entry[]；容忍 append 到一半的残缺末行 |
| `src/types.ts` | session-format v3 的全部 entry / message 类型 |
| `src/render/full.ts` | L0/L1 渲染引擎：按文件顺序忠实渲染所有 entry |
| `src/render/l0.ts` `l1.ts` | 薄封装：renderFull + level 开关 |
| `src/render/l2.ts` | 骨架渲染：user prompt 全量 + 每轮最终答复 + 工具一行摘要 |
| `src/render/truncate.ts` | 截断（inline 级 + line 级）与全部预算常量 |
| `src/render/shared.ts` | frontmatter、统计、围栏、分支提示、`GARDEN_VERSION` |

## 关键设计点

- **tree → 线性**：session entry 经 `id/parentId` 组成树，但渲染不做树重建，
  按文件 append 顺序输出；`parentId` 不是上一条时插入 `> ⑂ 跳回分支点` 提示
  （理由与细节见 wiki/internals/concepts/session-format.md）。
- **L0/L1 共用引擎**：两者差异只是截断开关（`truncate` 布尔），避免两份渲染逻辑漂移。
- **增量语义**：session 是 append-only，源文件变新才重生成；渲染逻辑变更靠
  `GARDEN_VERSION` bump 触发全量重生成（流程见 wiki/internals/tasks/tune-budget.md）。

## 已知限制

- `collectJobs` 只扫一层子目录；sessions 下的嵌套目录（如 `.mono/`，约 67 个文件）
  不会被转换（2026-09-14 发现，待决策是否递归）。
- 未来方向（未实现）：接入 pi 扩展在 session 保存时自动转换、watch 模式。
