# CLI 字典（garden）

入口：`src/cli.ts`。`npm link` 后可直接用 `garden` 命令。

## 用法

```bash
garden                     # 转换 ~/.pi/agent/sessions → ~/.pi/agent/garden
garden <sessions目录>      # 输出到其同级 garden/
garden <xxx.jsonl>         # 单文件模式
garden ... -o <输出目录>   # 自定义输出目录
garden -h                  # 帮助
```

## 参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `[path]`（位置参数） | sessions 目录或单个 .jsonl | `~/.pi/agent/sessions` |
| `-o, --output <dir>` | 输出根目录 | sessions 的同级 `garden/` |
| `-h, --help` | 打印用法 | — |

无其他参数（截断预算等均为常量，见 wiki/internals/reference/constants.md）。

## 行为

- **目录模式**：扫描 `sessions/<子目录>/*.jsonl`（一层，嵌套目录不递归——已知限制，
  见 wiki/internals/concepts/system-map.md）；也接受 sessions 根目录下直接的 .jsonl
- **单文件模式**：按 `<...>/<sub>/<file>.jsonl` 推导输出位置为 `garden/<sub>/<file>.<level>.md`；
  同目录兄弟 .jsonl 会参与编号排序（只解析、不生成输出）
- **输出**：每个 session 生成 `.l0.md` / `.l1.md` / `.l2.md` / `.l3.md` 四个文件，
  目录结构镜像 sessions 子目录；文件名 `<本地日期>-<序号>-<slug>`（规则见
  wiki/internals/reference/output-format.md）
- **清理**：改名/序号漂移产生的旧命名文件，按 frontmatter `session_id` 匹配删除
- **增量**：输出 mtime ≥ 源 mtime 且 frontmatter `version` == 当前 `GARDEN_VERSION`
  才跳过；两个条件任一不满足即重新生成
- 单个文件失败不影响其余（打印 `✗` 并继续）

## 输出摘要

```
garden: N 个 session → <输出根目录>
  ✓ <sub>/<file>.jsonl → <base> (.l0.md .l1.md .l2.md .l3.md)   # 有更新
  ✗ <sub>/<file>.jsonl: <原因>                                # 失败
完成: X 更新, Y 已是最新[, 清理 N 个旧文件][, Z 失败]
```

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功（含「全部已是最新」） |
| 1 | 输入路径不存在，或有文件转换失败 |
