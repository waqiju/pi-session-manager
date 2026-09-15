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
| `pathsForFile(src) => { sub, outRoot }` | 单文件路径推导：`.../sessions/<sub>/<file>.jsonl` → `<root>/garden`（纯推导，不校验布局） |
| `processFile(src, sub, outRoot) => { written, skipped }` | 转换单个 session（含增量判断） |
| `isUpToDate(outPath, srcMtime) => boolean` | mtime + 版本标记双重判断 |

## session-list.ts（快速 session 列表，供 `/garden` 选择器；数据源 = garden md，不读 jsonl）

| 导出 | 说明 |
|------|------|
| `listProjectSessions(gardenDir, opts?) => Promise<SessionListItem[]>` | current scope：一层 `*.lN.md`，每 base 优选 l2>l3>l1>l0，一次有界读 |
| `listAllSessions(gardenRoot, opts?) => Promise<SessionListItem[]>` | all scope：全部子目录（含 symlink 目录，跳过隐藏目录），子目录间并发 |
| `parseGardenFrontmatter(text) => GardenFrontmatter` | 解析 frontmatter：sessionId / name / cwd / started / ended / source / parent_session / messageCount（各 role 求和） |
| `extractFirstUserMessage(body) => string \| undefined` | 首个 `## 🙋 User` 小节正文（上限 300 字符） |
| `stripFrontmatter(text) => string` | 剥掉 md 开头的 yaml frontmatter |
| `collectMdFiles` / `collectSubdirs` / `gardenDirForSessionDir` / `gardenRootForSessionDir` | 目录扫描与路径推导 |
| `SessionListItem` | 选择器数据形状；jsonl 路径由 `<sessionsRoot>/<sub>/<frontmatter source>` 重建；附带 `mdDir`/`mdBase`（删除时清产物用）；`firstMessage` 空时兜底 `"(no messages)"` |

## session-tree.ts（选择器纯逻辑：fork 树 + 搜索）

| 导出 | 说明 |
|------|------|
| `buildSessionTree(items) => TreeNode[]` | 按 jsonl 文件名（basename）配对父子，零 syscall；roots/子节点按子树 latestActivity 降序；环防御不丢节点 |
| `flattenSessionTree(roots) => FlatNode[]` | 树 → 带缩进元数据（depth/isLast/ancestorContinues）的平铺列表 |
| `basenameAny(p) => string` | 同时切 `/` 和 `\`（Windows 遗留 parentSession 是反斜杠路径） |
| `parseSearchQuery(query) => ParsedQuery` | `re:` 正则 / `"phrase"` 精确 / fuzzy token（语法同内建） |
| `fuzzyMatch(query, text)` / `matchSession(item, parsed)` / `filterAndSortSessions(items, query)` | 子序列模糊匹配与过滤排序（score 升序，同分按最近活跃；语料 WeakMap 缓存） |

## textwidth.ts（终端文本宽度，选择器渲染用）

| 导出 | 说明 |
|------|------|
| `visibleWidth(text) => number` | 显示宽度：ANSI 零宽、CJK/emoji 2 列 |
| `truncateToWidth(text, maxWidth, ellipsis?) => string` | 按列截断；不劈宽字符；截断处补 reset 防样式泄漏 |
| `stripAnsi(text) => string` | 去 ANSI 转义 |

## garden-selector.ts（自绘选择器组件，extensions/ 下）

| 导出 | 说明 |
|------|------|
| `GardenSelectorComponent` | `ctx.ui.custom` 组件：render/handleInput/invalidate/dispose + focused；构造即开始加载 current scope |
| `LineInput` | 极简行输入（code-point 安全；插入/退格/移动/ctrl+a/e/u/k/w；粘贴换行变空格） |
| `deleteSessionFile(path)` / `deleteGardenOutputs(item)` | 删除 jsonl（trash 优先回退 unlink）+ 按 frontmatter session_id 清全部 md 产物 |
| `SelectorTheme` / `SelectorKeybindings` | 结构化注入接口（pi 的 Theme / KeybindingsManager 天然满足；组件零运行时 pi 依赖） |

## open.ts（gardener-open 打开器）

| 导出 | 说明 |
|------|------|
| `GARDEN_LEVELS` / `isGardenLevel(s)` | `l3 > l2 > l1 > l0` 优先级 |
| `pickHighestLevelFile(dir, base, level?) => string \| null` | 取存在的最高级别 md；指定级别时不回退 |
| `detectPlatform(env, platform, release) => "win32"\|"wsl"\|"darwin"\|"linux"` | WSL 判定：env 标记或 kernel release 含 microsoft/wsl |
| `buildOpenCommand(file, platform, env) => OpenCommand` | 拼命令；`PI_GARDEN_OPEN_CMD` 覆盖（`{file}` 占位或追加末参） |
| `openFile(file, env?, platform?) => Promise<{ ok, detail }>` | WSL 先 `wslpath -w` 翻译；spawn 成功即返回（打开器类进程不认退出码） |

## extensions/garden.ts（pi 扩展）

| 导出 | 说明 |
|------|------|
| `default (pi: ExtensionAPI) => void` | pi 扩展入口：事件接线（触发点与配置见 wiki/internals/reference/extension.md） |
| `readConfig(env) => GardenConfig` | 读 `PI_GARDEN*` 环境变量 |
| `gardenPathsFor(sessionFile) => { sub, outRoot } \| null` | `pathsForFile` + 标准 sessions 布局校验 |
| `convertSessionFile(sessionFile) => { written, skipped, base } \| null` | 转换单个 session；布局不合或文件不存在返回 null；`base` = 输出文件名主体（重命名后选择器同步用） |
