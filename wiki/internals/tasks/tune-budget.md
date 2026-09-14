# 调整截断预算（tune-budget）

调整截断预算常量或截断行为（如改头尾比、新增预算类别），并安全地全量重生成。

## Before You Begin

必读：wiki/internals/concepts/truncation.md —— 设计哲学（宁多不少、6:4、整行、永不硬切）
和现有预算的统计依据。新预算最好也有数据支撑（测量脚本可参考当时会话的做法：
遍历 sessions 统计尺寸分位数）。

## Steps

1. 改 `src/render/truncate.ts` 顶部的预算常量（或截断逻辑本身）
2. **bump `src/render/shared.ts` 的 `GARDEN_VERSION`**——增量判断靠 frontmatter 里的
   版本标记，不 bump 则旧输出被当作最新，不会重生成
3. `npm test`——注意 `test/sample.ts` 的 fixture 行数是按当前预算算的
   （预算变化会导致省略行数等断言失败，同步更新 fixture 注释与断言）
4. 全量重生成：`node src/cli.ts`（版本不一致 → 自动全部重跑）
5. 抽查一个有代表性的 session（thinking 长、工具输出多、有 edit diff 的）

## Verify

- 抽查文件的 frontmatter `version` 是新版本号
- `awk '{ if (length($0) > m) m = length($0) } END { print m }' xxx.l1.md`
  最长行符合预期（通常 ≤ ~600，除非是无分隔符/不值得截的整行保留）
- l1 总体积变化符合预期：`du -sh ~/.pi/agent/garden`

## Troubleshooting

| 问题 | 处理 |
|------|------|
| 重跑后输出没变 | 检查是否忘记 bump `GARDEN_VERSION`；或确认改的是生效的代码路径（L1 截断在 `full.ts` 的 `truncate` 分支） |
| 大量 fixture 断言失败 | fixture 的 padding 行数是按预算精确算的；预算变了就重算并更新 `sample.ts` 顶部注释与 `render.test.ts` 的省略行数断言 |
| 新预算下体积没明显变化 | 多数块本来就在预算之下（如 toolResult p50=490）；先看分位数再调 |

## Related

- wiki/internals/concepts/truncation.md — 哲学与预算依据
- wiki/internals/reference/constants.md — 全部常量表
- wiki/internals/tasks/run-conversion.md — 重生成与抽查命令
