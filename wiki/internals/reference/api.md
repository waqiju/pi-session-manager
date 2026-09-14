# API 字典（src/ 导出函数）

零依赖 ESM 包，`import ... from "./xxx.ts"`（type-stripping，必须带 `.ts` 后缀）。

## parser.ts

| 导出 | 签名 | 说明 |
|------|------|------|
| `parseSessionFile` | `(filePath: string) => ParsedSession` | 读文件并解析 |
| `parseSessionText` | `(text: string) => ParsedSession` | 解析 jsonl 文本；残缺末行跳过 |
| `ParsedSession` | `{ header: SessionHeader \| null; entries: Entry[] }` | — |

## render/l0.ts · l1.ts · l2.ts · l3.ts

| 导出 | 说明 |
|------|------|
| `renderL0(header, entries, opts?: { sourceName?: string }) => string` | 全量渲染 |
| `renderL1(header, entries, opts?) => string` | 全量渲染 + 截断（见 wiki/internals/concepts/truncation.md） |
| `renderL2(header, entries, opts?) => string` | 骨架渲染（见 wiki/internals/concepts/lod-levels.md） |
| `renderL3(header, entries, opts?) => string` | 纯问答渲染：l2 基础上每轮只留最后一段 assistant text |

## render/full.ts

| 导出 | 说明 |
|------|------|
| `renderFull(header, entries, opts: { level: "l0" \| "l1"; sourceName?: string }) => string` | L0/L1 共用引擎；`level` 决定截断开关 |

## render/skeleton.ts

| 导出 | 说明 |
|------|------|
| `renderSkeleton(header, entries, opts: { level: "l2" \| "l3"; sourceName?: string }) => string` | L2/L3 共用引擎；`level` 决定 finalOnly（l3 每轮只留最终答复） |

## render/truncate.ts

| 导出 | 签名 | 说明 |
|------|------|------|
| `truncateLines` | `(text: string, budget: number, opts?: { headRatio?: number; inlineLimit?: number }) => string` | 完整流水线：逐行 inline → 块级 line |
| `truncateInline` | `(line: string, limit?: number, headRatio?: number) => string` | 单行内截断；软断行、永不硬切 |
| `truncateEachLine` | `(text: string, limit?: number) => string` | 对已渲染文本逐行 inline（用于 JSON.stringify 后的物理行） |
| `truncateLongStrings` | `(value: unknown, budget: number) => unknown` | 深遍历 JSON，截断超长字符串值 |

## render/shared.ts

| 导出 | 说明 |
|------|------|
| `GARDEN_VERSION` | 生成器版本；frontmatter 的 `version` 字段；增量判断依据 |
| `frontmatter(header, entries, level, sourceName?) => string` | YAML frontmatter |
| `collectStats(entries) => Stats` | 消息计数、模型列表、token/成本汇总、session 名 |
| `fence(text, info?) => string` | 自适应代码围栏（内容含 ``` 时自动升级） |
| `branchNote(prev, entry) => string \| null` | parentId 跳回检测 → `> 🔀` 提示行 |
| `truncateHeadTail` 等已移除 | 截断统一在 truncate.ts |
| `fmtTime` / `fmtBytes` / `imagePlaceholder` | 小工具 |
| `DETAILS_DROP_TOOLS` / `isEmptyDetails` | L1 的 details 丢弃策略（见 wiki/internals/reference/constants.md） |

## cli.ts（可编程复用）

| 导出 | 说明 |
|------|------|
| `collectJobs(input) => { jobs, defaultOut }` | 扫描 sessions 目录 |
| `processFile(src, sub, outRoot) => { written, skipped }` | 转换单个 session（含增量判断） |
| `isUpToDate(outPath, srcMtime) => boolean` | mtime + 版本标记双重判断 |
