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
| `processFile(prepared, outDir, levels?) => { written, skipped }` | 渲染并写出单个 session 的级别文件（含增量判断）；`levels` 缺省 `DEFAULT_LEVELS` |
| `DEFAULT_LEVELS` / `parseLevels(raw)` | 默认导出级别 `["l1","l3"]`；解析 `"l1,l3"` 形式（非法项忽略，全非法 → `undefined` 回退默认） |
| `isUpToDate(outPath, srcMtime) => boolean` | mtime + 版本标记双重判断 |
| `existingGardenDirs(outRoot) => string[]` | 现有 garden 项目目录：outRoot 下非隐藏子目录 + outRoot 自身（顶层直放 md 的非标准布局） |

## index-page.ts（garden 目录索引 index.md 生成）

| 导出 | 说明 |
|------|------|
| `generateDirIndex(dir) => Promise<DirIndexResult \| null>` | 重建一个项目目录的 index.md：frontmatter-only 扫描（不读正文）→ fork 森林；无会话 → null；内容无变化跳过写盘（`changed=false`）；链接 = 存在的最高级别 md 的相对路径 |
| `buildIndexPage(items, resolveFile) => string` | 索引页文本（纯函数）：标题 + 统计 chip + HTML 注释说明块 + 嵌套列表（🗂️ 有子会话 / 📄 单条，树间空行）；元数据反引号隔离（msgs/日期）、当年日期省略年份、label 转义 `[`/`]`、href 包 `<>`（文件名可能含括号/空格） |
| `INDEX_FILE_NAME` | `"index.md"`；不匹配 `*.lN.md`，列表加载与孤儿清理天然忽略它 |

## format.ts（会话列表展示格式化，index.md 与子树复制共用）

| 导出 | 说明 |
|------|------|
| `nodeLabel(item) => string` | name 优先（超 48 列截断）；无名回退首条消息摘要（36 列截断、加引号）；皆无 → `untitled` |
| `formatSizeLabel(bytes \| null) => string` | `500B` / `8KB` / `1.2MB`；null → `?` |
| `formatDate(d) => string` | `YYYY-MM-DD`（本地时区；导出文本不用相对时间，落盘后失真） |
| `formatDateShort(d, now?) => string` | 同年 → `MM-DD`，跨年 → `YYYY-MM-DD`（索引页用；当年省年份） |
| `cleanInline(t) => string` | 控制字符/换行 → 空格，折叠空白 |

## session-list.ts（快速 session 列表，供 `/garden` 选择器；数据源 = garden md，不读 jsonl）

| 导出 | 说明 |
|------|------|
| `listProjectSessions(gardenDir, opts?) => Promise<SessionListItem[]>` | current scope：一层 `*.lN.md`，每 base 优选 l3>l2>l1>l0，一次有界读 |
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
| `isCtrlLetter(data, letter)` | Ctrl+字母判定：legacy 控制字符 / Kitty CSI-u / modifyOtherKeys 三编码 |
| `formatAge(date) => string` | 相对时间（now/m/h/d/w/mo/y，选择器行内用） |
| `SelectorTheme` / `SelectorKeybindings` | 结构化注入接口（pi 的 Theme / KeybindingsManager 天然满足；组件零运行时 pi 依赖） |

## garden-clipboard.ts（/garden 选择器 Ctrl+Y 子树复制，extensions/ 下）

| 导出 | 说明 |
|------|------|
| `buildSubtreeCopyText(flat, resolveFile) => string` | 子树复制文本：自解释头部 + 编号树 + 绝对路径清单（粘贴给其他 AI 作 context） |
| `copyToClipboard(text) => { ok, error? }` | pbcopy / clip.exe(WSL) / wl-copy / xclip；3s 超时 |
| `COPY_SUBTREE_MAX` | 99；子树超过硬拒（防巨型树塞剪贴板） |

## garden-files.ts（/garden 选择器删除操作，extensions/ 下）

| 导出 | 说明 |
|------|------|
| `deleteSessionFile(path)` | 删除 jsonl（trash 优先回退 unlink） |
| `deleteGardenOutputs(item)` | 按 frontmatter session_id 清全部 md 产物（改名/重编号残留一并清） |

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
