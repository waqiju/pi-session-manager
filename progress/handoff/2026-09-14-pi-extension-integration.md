# Handoff: pi 扩展集成（garden-ext 分支）

- 日期：2026-09-14
- 项目：garden（pi-session-manager）
- 分支：`garden-ext`（worktree：`/mnt/d/1_Workspace/pi-session-manager-garden-ext`，基于 tag `v0.1.3`）
- 状态：完成并 E2E 验证；package 版本 0.1.2 → 0.2.0；`GARDEN_VERSION` 未变（无渲染行为变更）

## 为什么走 worktree

主检出 `/mnt/d/1_Workspace/pi-session-manager` 当时有 agent 在跑（且有未提交的 l3 改动），
从 tag `v0.1.3` 建 worktree 开发，`pi install` 也指向 worktree 路径。
**后续**：主检出空闲后，把 `garden-ext` 合回 main，并重指 `pi install`（或换成 git URL 分发），
然后删除 worktree（`git worktree remove`），否则 settings.json 里的本地路径会悬空。

## 本轮改动

| 文件 | 改动 |
|------|------|
| `src/cli.ts` | 抽出 `pathsForFile(src)`（单文件路径推导，`collectJobs` 复用） |
| `extensions/garden.ts` | 新增：pi 扩展薄适配层（事件接线 + `/garden` 命令），渲染全委托 src/ |
| `package.json` | `pi.extensions` manifest、`keywords: [pi-package]`、peerDependencies、0.2.0 |
| `test/extension.test.ts` | 新增 7 个测试（mock pi 对象；含 live 防抖的 Date.now 注入） |
| docs | README / AGENTS / system-map / api.md + 新增 reference/extension.md |

## 触发点设计（定案）

`session_start`（补漏）→ `agent_settled`（live，防抖默认 60s）→ `session_compact` →
`session_shutdown`（终态）。全部共享 `processFile` 增量判断，重复触发近零成本。
env：`PI_GARDEN=0` 停用；`PI_GARDEN_LIVE_INTERVAL_S` 调间隔（0=关 live）。
细节字典：wiki/internals/reference/extension.md。

## 关键实现决策

- **in-process import**：扩展直接 `import { processFile } from "../src/cli.ts"`；
  `import type` 引用 pi 类型，运行时被擦除 → 仍是零依赖包，`node --test` 直接可测。
  cli.ts 的 main-guard（`import.meta.url` 比对）在 jiti 加载下不会误触发。
- **布局防御**：`gardenPathsFor` 只接受 `.../sessions/<sub>/*.jsonl`，防止把 garden
  写到非常规路径。
- **防抖用闭包时间戳**，不起 timer（pi 扩展约束：factory 不得起后台资源）。
- **失败静默策略**：自动触发不 notify；相同错误只告警一次（防 live 刷屏）。

## 验证

- `npm test`：39 个测试全过（CLI 27 + 扩展 7 + 其余）。
- `python3 scripts/check_wiki_links.py`：OK。
- E2E：`pi install <worktree>` 后 `pi -p "..."`（print 模式，/tmp 独立 cwd），
  session 退出时自动生成 l0/l1/l2，frontmatter 与内容正确。

## 挂起事项

- 合回 main + 重指 install（见上）。
- watch daemon 模式（覆盖「没在跑 pi 也要转换」）——本轮明确缓做。
- 嵌套目录递归扫描决策（沿用上轮挂起）。
