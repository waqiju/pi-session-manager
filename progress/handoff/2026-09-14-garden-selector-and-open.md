# Handoff: /garden 快速选择器 + gardener-open（0.3.0）

- 日期：2026-09-14
- 项目：garden（pi-session-manager）
- 分支：`garden-ext`（worktree：`/mnt/d/1_Workspace/pi-session-manager-garden-ext`，基于 v0.1.3）
- 状态：完成；package 0.2.0 → 0.3.0；`GARDEN_VERSION` 不变；53 测试全过

## 背景

- 原 `/garden` 命令（转换）改名为 **`/gardener-output`**，`garden` 名字让位给新功能。
- 新增 **`/gardener-open [lN]`**：默认浏览器打开当前 session 的 garden md（默认取存在的
  最高级别 l3>l2>l1>l0；无产物先转换再开）。WSL 走 `wslpath -w` + `cmd.exe /c start`
  （explorer.exe 成功也返回非零，弃用）；`PI_GARDEN_OPEN_CMD` 可覆盖（{file} 占位）。
- 新增 **`/garden`**：快速 session 选择器，对标 /resume。动机：内建
  `buildSessionInfo` 逐行全读每个 jsonl，慢盘（drvfs）上数百 session 很慢。

## 关键设计（调查结论）

- **`SessionSelectorComponent` 是 pi 公共导出**（`@earendil-works/pi-coding-agent`），
  构造参数 = 两个 loader 回调 + onSelect/onCancel/onExit/requestRender +
  options{keybindings, renameSession} + 当前文件路径。fork 树（threaded）、搜索、
  Ctrl+D 删除（内建 trash）、rename、scope/sort 切换全部免费获得 → 真·等位。
  通过 `ctx.ui.custom()` 挂载（factory 传入真实 keybindings）。
- **动态 import pi 包**：`SessionSelectorComponent`/`SessionManager` 只在 `/garden`
  handler 里 `await import`，保持扩展文件零依赖可被 node --test 直接加载。
- **快速列表（src/session-list.ts）**：每文件一次有界读（首 64KB）→ header（fork 链
  `parentSession`）+ 缓冲内首条 user 消息 + session_info 名；modified 用 stat.mtime。
  再从 garden md frontmatter 富化 name/messageCount（读 l2→l0→l1→l3 第一份）。
- **onExit 在当前 pi 版本实际无按键触发**，映射 done(null) 安全。
- 实测（309 个 / 138.7MB，本机温缓存）：快速列表 2.0s vs 内建式全读 1.5s ——
  本机差距不大，但字节量 21MB vs 138.7MB（6.6×），冷缓存/更慢的盘差距放大。

## 已知取舍（用户已拍板 A2 方案）

- 不建 `allMessagesText` → 全文搜索不可用（id/name/cwd 可搜）。
- 未转换且未命名的 session 显示空标题；富化命中率取决于转换覆盖（本机 286/309）。
- `ctx.switchSession` 无 cwdOverride（内建的 cwd 缺失重选流未暴露）→ 跨机器 session
  切换失败只 notify。
- rename 用 `SessionManager.open().appendSessionInfo()`（与内建同路径；全量加载该文件，
  低频操作可接受）。

## 验证

- `npm test` 53 全过（新增 session-list 7 + open 5 + 扩展命令 3）。
- E2E：`pi -p` print 模式跑通（新 import 在 jiti 下加载正常，shutdown 自动转换产出三级 md）。
- 选择器 TUI 交互未自动化覆盖，需人工开 pi 验 `/garden`（组件是官方的，风险在 loader 数据形状）。

## 挂起事项（沿旧 + 新增）

- **合回 main + 重指 pi install**（主检出 agent 收工后；否则 settings.json 路径悬空）。
- 选择器人工 TUI 验证（fork 树显示、删除、rename、scope 切换）。
- A3 渐进增强（后台慢速全扫描富化 firstMessage/全文搜索）—— 需要时加 env 开关再做。
- watch daemon 模式、嵌套目录递归扫描决策（沿旧）。
