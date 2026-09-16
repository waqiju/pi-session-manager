# 导出级别可配置 + 默认只导 l1/l3

- 日期：2026-09-15
- 项目：garden（pi-session-manager）
- 状态：完成；package 0.3.3

## 背景

此前所有触发点（session_start / agent_settled / session_compact / session_shutdown /
/gardener-output / CLI）都经 `processFile` 无条件导出全部四级。实测 316 个 session：
l0 101M + l1 40M + l2 7.3M + l3 4.4M ≈ 153M，其中 l0 与源 jsonl 冗余、
l2 语料与 l3 重叠。

## 变更

- **默认导出级别 l1 + l3**（省 ~71% 盘占）：`src/cli.ts` 新增 `DEFAULT_LEVELS`
  与 `parseLevels()`（逗号分隔、大小写不敏感、去重；非法项忽略，全非法回退默认）；
  `processFile(prepared, outDir, levels?)` 按级别集过滤
- **配置**：扩展 env `PI_GARDEN_LEVELS`；CLI flag `--levels`。
  优先级：`--levels` > `PI_GARDEN_LEVELS` > 默认
- **选择器语料优先级** `l2>l3>l1>l0` → **`l3>l2>l1>l0`**（与默认导出对齐；
  l2 语料并不比 l3 多，保持简单一致）
- **`/gardener-open lN`**：指定的级别不在默认导出集时，按需只生成该级别再打开
  （原行为是直接报“无输出文件”）
- **`garden --sync`**：CLI 同步模式——递归扫描 garden 全目录，删除孤儿文件（session 已删）+ 多余级别文件（不在当前 levels 集），然后增量转换；`--dry-run` 只打印不删。实现要点：`removeStaleOutputs`（改名清理）和 `syncCleanup`（孤儿+stale level）用独立索引副本，避免前者 `index.delete(key)` 污染后者

## 关键决策

- 旧配置产出的 l0/l2 文件**按归档语义保留**，不自动清理、不提供 prune 命令
- 渲染内容未变，**不 bump GARDEN_VERSION**（只影响"写哪些级别"，不影响"级别内容"）
- 增量判断本就是 per-level mtime，级别过滤天然兼容

## 测试

- 89 个全过。新增/改写：
  - cli.test.ts：默认只导 l1/l3；`--levels` 全量四级 + 体积排序；env 生效；flag 覆盖 env；非法回退默认；`--sync` 孤儿+stale level 清理；`--dry-run` 不删文件
  - extension.test.ts：readConfig levels 解析（含大小写/去重/回退）；convertSessionFile 默认 2 级 + 显式指定
  - session-list.test.ts：级别优选 l3>l2>l1>l0（齐全取 l3、缺 l3 退化 l2）

## 文档

- wiki：reference/extension.md（env 表、触发点说明）、reference/cli.md（`--levels` + `--sync`）、
  reference/api.md（processFile 签名修正 + parseLevels）、concepts/lod-levels.md（默认导出决策）
- README 四级输出表下补默认导出说明
- 顺手修正过时表述：extensions/garden.ts 头注与 extension.md 的"三级 markdown"（实际早已是四级）
