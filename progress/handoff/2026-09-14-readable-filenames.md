# handoff: 可读文件名（日期-序号-slug）

分支 `feat/readable-filenames`（worktree: `../pi-session-manager-wt-naming`，基于 v0.2.0）。

## 决策（用户拍板）

- 文件名：`<本地日期>-<序号>-<slug>.<level>.md`，如 `2026-08-31-002-禁用进程-CPU占用高.l1.md`
- 不要时间、不要短 id；序号同目录同日期内按 header timestamp 升序，001 起
- slug 只取 `session_info.name`（last wins），无 → `untitled`；不用首条消息兜底
- 名字中空白 → `_`；非法字符同样 → `_`；≤40 code point
- 日期用运行机器**本地时区**（人按本地时间回忆；frontmatter 的 started 仍 UTC）
- 旧文件清理按用户方案：读已有输出前 2KB 的 frontmatter `session_id` 匹配删除

## 实现要点

- 新增 `src/naming.ts`（纯函数：slugifyName / localDate / extractNamingInfo / planBaseNames）
- `cli.ts` 重构为按子目录分组 → prepareGroup（全量解析 + 命名计划）→ 清理 → 增量写入；
  序号是组内全局属性，这是重构的根本原因
- 单文件模式：兄弟 .jsonl 参与编号排序但不生成输出
- **未 bump GARDEN_VERSION**（渲染行为未变；迁移靠新路径不存在自然触发全量重生成）
- 迁移：合并后对真实 sessions 跑一次即可自动删除旧式 uuid 文件名（已按 uuid 匹配验证）

## 验证

- `npm test` 45 个全过（新增 naming 9 个 + cli 重编号/迁移 2 个）
- 真实 sessions（309 个）转换到 **临时目录**验证通过；真实 garden 未动

## 合并后要做

1. 合入 main 后对 `~/.pi/agent/sessions` 正常跑一次 garden，自动完成存量迁移
2. 注意：若旧代码（如正在跑的 agent）再次运行会重新生成旧式命名文件，
   新代码下次运行会再次迁移清理，无害但会抖动

## 后续议题（用户明确暂放）

- 子目录名 `--D--1_Workspace-bot_home--` 难读（cwd 转义 scheme）
- 每 session 4 个文件让目录膨胀（可考虑按 level 分层子目录）
- `.mono/` 嵌套目录未扫描（system-map 已知限制）
