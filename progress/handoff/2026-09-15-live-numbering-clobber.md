# Handoff: live 转换编号撞车（Ctrl+N 后兄弟 session 被顶掉）—— 已解决

- 日期：2026-09-15
- 项目：garden（pi-session-manager）
- 状态：**已解决**（v0.3.5）

## 1. 现象

`/garden` 里 Ctrl+N 新建子会话后，选择器中原有的兄弟节点（如 node11）显示成新会话
（node-new）的内容；`/gardener-output all` 后有时恢复、有时要跑两遍。

## 2. 根因（三个缺陷叠加，temp/repro-ctrl-n-clobber.ts 稳定复现）

1. **live 路径编号是单 session 组算的**：`convertSessionFile` 调 `prepareGroup([{src: 当前}]`)
   → `planBaseNames` 永远给当日 001 → 与同日同 slug（两个未命名都是 `untitled`）的兄弟
   文件撞名，**writeFileSync 直接覆盖别人的 md**。不只 Ctrl+N：任何"当日非第一个且未命名"
   session 的 live 触发（agent_settled/session_start/...）都会踩当日 001。
2. **`isUpToDate` 不校验 session_id 归属**：撞车文件 mtime 新 + version 对 → 全量转换时
   被撞的 session 被 SKIP，修不回来。
3. **扩展 `/gardener-output all` 不做旧命名清理**（只 CLI 目录模式有 `removeStaleOutputs`），
   且 `removeStaleOutputs` 用循环前的索引快照删文件——重编号交接时会误删别的 session
   刚重写的文件（处理顺序：旧主在前、新主在后）。

另修：扩展 all 原本对**全部** jobs 一次 `planBaseNames`（跨子目录编号错乱）→ 改按子目录分组。

## 3. 修复（v0.3.5）

- `src/cli.ts`
  - `isUpToDate` 增加 session_id 归属校验（顺带改 2KB head 读，不再全读文件）
  - `removeStaleOutputs` 删除前重读文件头复核当前归属（防快照过期误删）
  - 新增 `avoidForeignBase`（live 撞车递增避让，**永不覆盖别人的文件**；
    序号短暂不准由下次全量归位）
  - 新增 `convertGroup`（组内编号 + 清理 + 增量写 + 可选 include 过滤），
    CLI 目录模式 / 单文件模式 / --sync / 扩展 all 四路共用
- `extensions/garden.ts`
  - `convertSessionFile` 走 `avoidForeignBase`
  - `/gardener-output all` 按子目录分组走 `convertGroup`
- 测试：96 全过。新增 isUpToDate 归属校验、removeStaleOutputs 复核、avoidForeignBase、
  CLI 同 slug 重编号交接 e2e、live 撞车避让 + 单遍全量自愈、all 多子目录编号。
- 文档：wiki/internals/tasks/run-conversion.md（增量语义 + Troubleshooting）、
  wiki/internals/reference/extension.md（行为细节：live 避让 / 全量自净）。

## 4. 运维

- 推送后必须 `pi update https://github.com/waqiju/pi-session-manager` 刷新
  `~/.pi/agent/git/...` 的 clone（pi 不自动 pull），再重启 pi / `/reload`。
