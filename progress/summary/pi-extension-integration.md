# Pi Extension 集成总结

- 日期：2026-09-14
- 项目：garden（pi-session-manager）
- 状态：完成；package 0.1.2 → 0.2.0

## 架构设计

- **in-process import**：扩展直接 `import { processFile } from "../src/cli.ts"`
- **零运行时依赖**：`import type` 引用 pi 类型，运行时被擦除
- cli.ts 的 main-guard 在 jiti 加载下不会误触发

## 触发点

| 事件 | 说明 |
|------|------|
| `session_start` | 补漏 |
| `agent_settled` | live，防抖默认 60s |
| `session_compact` | 压缩后触发 |
| `session_shutdown` | 终态 |

全部共享 `processFile` 增量判断，重复触发近零成本。

## 配置

| 环境变量 | 说明 |
|----------|------|
| `PI_GARDEN=0` | 停用扩展 |
| `PI_GARDEN_LIVE_INTERVAL_S` | 调整 live 间隔（0=关 live） |

## 失败策略

- 自动触发不 notify
- 相同错误只告警一次（防 live 刷屏）

## 关键实现

- **布局防御**：`gardenPathsFor` 只接受 `.../sessions/<sub>/*.jsonl`
- **防抖用闭包时间戳**，不起 timer（pi 扩展约束：factory 不得起后台资源）

## 文档

- wiki/internals/reference/extension.md
