# CLI 字典（garden）

入口：`src/cli.ts`。`npm link` 后可直接用 `garden` 命令。

## 用法

```bash
garden                     # 转换 ~/.pi/agent/sessions → ~/.pi/agent/garden
garden <sessions目录>      # 输出到其同级 garden/
garden <xxx.jsonl>         # 单文件模式
garden ... -o <输出目录>   # 自定义输出目录
garden ... --levels l0,l1  # 指定导出级别（默认 l1,l3）
garden --sync [path]       # 同步：删除孤儿 + 多余级别 + 增量转换
garden --sync --dry-run    # 同步演练：只打印将删除的文件
garden -h                  # 帮助
```

## 参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `[path]`（位置参数） | sessions 目录或单个 .jsonl | `~/.pi/agent/sessions` |
| `-o, --output <dir>` | 输出根目录 | sessions 的同级 `garden/` |
| `--levels <列表>` | 导出级别，逗号分隔（子集 `l0/l1/l2/l3`） | 环境变量 `PI_GARDEN_LEVELS`，再缺省 `l1,l3` |
| `--sync` | 同步模式：扫描 garden 目录，删除孤儿文件（session 已删）+ 多余级别文件（不在 `--levels` 集中），然后增量转换 | — |
| `--dry-run` | 与 `--sync` 搭配，只打印删除计划不实际操作 | — |
| `-h, --help` | 打印用法 | — |

优先级：`--levels` > `PI_GARDEN_LEVELS` > 默认 `l1,l3`；非法级别忽略，全部非法回退默认。
其余无参数（截断预算等均为常量，见 wiki/internals/reference/constants.md）。

## 行为

- **目录模式**：扫描 `sessions/<子目录>/*.jsonl`（一层，嵌套目录不递归——已知限制，
  见 wiki/internals/concepts/system-map.md）；也接受 sessions 根目录下直接的 .jsonl
- **单文件模式**：按 `<...>/<sub>/<file>.jsonl` 推导输出位置为 `garden/<sub>/<file>.<level>.md`；
  同目录兄弟 .jsonl 会参与编号排序（只解析、不生成输出）
- **输出**：每个 session 按级别集生成 `.l0.md` / `.l1.md` / `.l2.md` / `.l3.md`
  （默认只导 l1/l3——l0 与源 jsonl 冗余、l2 语料与 l3 重叠；`--levels` / `PI_GARDEN_LEVELS` 可配），
  目录结构镜像 sessions 子目录；文件名 `<本地日期>-<序号>-<slug>`（规则见
  wiki/internals/reference/output-format.md）。改配置减少级别后，旧级别文件按归档语义保留，不自动清理
- **清理**：改名/序号漂移产生的旧命名文件，按 frontmatter `session_id` 匹配删除
- **增量**：输出 mtime ≥ 源 mtime 且 frontmatter `version` == 当前 `GARDEN_VERSION`
  才跳过；两个条件任一不满足即重新生成
- 单个文件失败不影响其余（打印 `✗` 并继续）
- **同步模式（`--sync`）**：在增量转换前，先递归扫描 garden 全目录（含子目录），
  读取每个 `.lN.md` 的 frontmatter `session_id`，与 sessions 中的实际 session 比对：
  - `session_id` 无对应 jsonl → 孤儿文件，删除
  - `session_id` 存在但级别不在当前 `--levels` 集 → 多余级别，删除
  - `--dry-run` 时只打印 `删除 orphan/stale level: <path>`，不实际 `unlink`
  - 不带 `--sync` 时的常规模式只清理同 session_id 内改名/重编号产生的旧文件，
    不处理孤儿和多余级别

## 输出摘要

```
garden: N 个 session → <输出根目录>
  ✓ <sub>/<file>.jsonl → <base> (.l1.md .l3.md)   # 有更新（列出实际写入的级别）
  ✗ <sub>/<file>.jsonl: <原因>                                # 失败
完成: X 更新, Y 已是最新[, 清理 N 个旧文件][, Z 失败]
```

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功（含「全部已是最新」） |
| 1 | 输入路径不存在，或有文件转换失败 |
