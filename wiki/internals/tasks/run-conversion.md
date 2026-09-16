# 运行转换（run-conversion）

把 sessions 目录转换成 garden 四级 markdown，含增量语义。

## Before You Begin

- Node.js ≥ 22.18（`node --version` 确认；依赖原生 type-stripping，无构建步骤）
- 知道 sessions 目录位置：默认 `~/.pi/agent/sessions`（本机是软链 → `/mnt/d/sd/_pi/sessions`）

## Steps

```bash
# 常规：转换全部 session（增量，通常几秒）
node src/cli.ts

# 指定 sessions 目录 / 单文件 / 自定义输出
node src/cli.ts <sessions目录>
node src/cli.ts <xxx.jsonl>
node src/cli.ts ... -o <输出目录>
```

- 输出默认在 sessions 的同级 `garden/`，目录结构镜像 sessions 的子目录
- 增量：输出 mtime ≥ 源 mtime、frontmatter `version` 等于当前 `GARDEN_VERSION`、且
  frontmatter `session_id` 等于本 session 才跳过；想全量重生成，bump `GARDEN_VERSION`
  （见 Related 的 tune-budget）。session_id 校验是撞车自愈的关键：live 转换曾把别 session
  的内容写进本 base，不查归属会把别人的文件当“最新”永久跳过
- 正在写入的活跃 session 转换安全（parser 容忍残缺末行），下次运行会补上新内容

## Verify

- 末行输出 `完成: N 更新, M 已是最新`，无 `失败`
- 抽查某个输出：`head -25 xxx.l1.md` 能看到 frontmatter，且
  `version` 等于 `src/render/shared.ts` 里的 `GARDEN_VERSION`

## Troubleshooting

| 问题 | 处理 |
|------|------|
| `路径不存在` | 检查参数；默认路径依赖 `~/.pi/agent/sessions`，确认软链目标可达 |
| 改了渲染代码但输出没变 | 忘了 bump `GARDEN_VERSION`——增量判断把旧输出当作最新 |
| 某个 session 转换失败 | 错误会打印 `✗ <file>: <原因>`，其余不受影响；多为文件读写权限问题 |
| 找不到 `.mono/` 等嵌套目录的转换结果 | 已知限制：当前只扫一层子目录，见 wiki/internals/concepts/system-map.md |
| 选择器里某 session 显示成别的内容/消失 | 编号撞车残留（live 转换单 session 组序号撞同日兄弟）。0.3.5 起已防：live 路径撞车避让不覆写，`/gardener-output all` 单遍自愈（增量含 session_id 归属校验 + 删除前复核）。旧版本跑一遍 `/gardener-output all` 也可恢复 |

## Related

- wiki/internals/concepts/system-map.md — 数据流与模块划分
- wiki/internals/tasks/tune-budget.md — 全量重生成的标准流程
- wiki/internals/reference/cli.md — 参数与退出码字典
