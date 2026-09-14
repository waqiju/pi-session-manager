# 截断（truncation）

l0 → l1 的核心机制。目标：在**不破坏可读性**的前提下把体积压下来，
并让每一处删减都有明确的标记和可查的原文（l0）。

## 设计哲学

1. **宁多不少**：拿不准就多留。跨界行完整保留、断点向「多保留」方向延展。
2. **头尾 6:4**：保留头部 60% + 尾部 40%，砍中间。
3. **整行 / 词边界断点**：绝不在行中间、单词中间制造锯齿。
4. **永不硬切**：找不到分隔符的行整行保留。

## 三级机械截断

| 级 | 粒度 | 状态 |
|----|------|------|
| block 级 | l1 → l2 整块取舍（如 toolResult 整块丢弃） | 属各级渲染规则，见 wiki/internals/concepts/lod-levels.md |
| **line 级** | 块内按行头尾截断 | 已实现，`truncateLines()` |
| **inline 级** | 单行内字符级截断 | 已实现，`truncateInline()` |

流水线：`原始文本 → 逐行 inline 截断（行封顶）→ 块级 line 截断（块预算）`，两层独立可组合。

### line 级

- 文本 ≤ 预算：原样返回
- 否则按 6:4 分头/尾预算，从两端 greedy 拿**整行**，累计 ≥ 预算即停，
  跨界行完整保留
- 头尾行数重叠 → 返回原文（不做无意义截断）
- 标记：`\n\n... (omitted X chars / Y lines) ...\n\n`

### inline 级

- 行 > `INLINE_LIMIT`（500）：`head ... (omitted X chars) ... tail`（头 300 / 尾 200）
- head 向后、tail 向前找最近的空白/逗号/中文标点再断；找不到分隔符的行整行保留
- 省略量 < `INLINE_MIN_OMIT`（64）不截——marker 本身约 30 字符，省得太少只是噪声

## 预算与依据

常量集中在 `src/render/truncate.ts`。数值来自 2026-09-14 对 370 个真实 session
（约 66.6MB）的统计测量，调整流程见 wiki/internals/tasks/tune-budget.md。

| 常量 | 值 | 依据 |
|------|----|------|
| `TOOL_RESULT_BUDGET` | 1000 | toolResult p50=490、p90=4904；1000 字符 ≈ 一屏（12~15 行）；63% 的块不被截 |
| `TOOL_ARG_BUDGET` | 800 | bash 命令 p50=202、p90=694 → 90% 的命令原样可见 |
| `THINKING_BUDGET` | 1000 | thinking p50=393、p75=1495；同 toolResult 的「一屏」原则 |
| `DETAILS_BUDGET` | 4000 | edit 的 diff/patch 是实质内容，多留；巨型 diff（实测最大 26K）封顶 |
| `INLINE_LIMIT` | 500 | line 级截断后 >500 字符的残留行共 3.2MB（toolResult 2.06 / thinking 0.94 / args 0.24） |
| 头尾比 | 6:4 | 实测 error 关键行十分位分布近乎均匀 `[8,9,10,10,10,10,11,10,11,11]`（尾部仅略高）→ 头尾都留、砍中间，无需向尾部过度倾斜 |

## 已知边界（feature，非 bug）

- **无分隔符行整行保留**：如纯 base64 行。实测稀有（超预算块中无换行的仅个位数）。
- **宁多不少的超出量**：line 级跨界行完整保留，单块最坏超出一个 inline 封顶值。
- **JSON 物理行**：`JSON.stringify` 把字符串值的换行转义成 `\n` 字面量，
  会把多行值合并成一条超长物理行（实测 4254 字符）——因此 args / details / custom
  的 JSON 输出再过一道 `truncateEachLine()` 逐行封顶。
- **过密文本不值得截**：一条 624 字符的 patch 行，断点间只能省 30 字符
  （≈ marker 长度）——`INLINE_MIN_OMIT` 的存在理由。
