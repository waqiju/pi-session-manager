# Extension 字典（extensions/garden.ts）

pi 扩展形态：会话生命周期内自动把**当前 session** 转成四级 markdown（默认只导 l1/l3，`PI_GARDEN_LEVELS` 配置）。
渲染核心在 `src/`（与 CLI 同源），扩展只做事件接线，因此输出、增量语义与 CLI 完全一致。

## 安装

| 方式 | 命令 | 适用 |
|------|------|------|
| 本地路径 | `pi install /path/to/pi-session-manager` | 开发期；不拷贝，改完 `/reload` 即生效 |
| git package | `pi install https://github.com/waqiju/pi-session-manager` | 稳定后分发 |
| 临时试用 | `pi -e /path/to/pi-session-manager` | 单次运行 |

> **git package 不自动更新**：pi 把 git 包 clone 到 `~/.pi/agent/git/<host>/<org>/<repo>` 后不再同步。
> 推送新修复后必须 `pi update https://github.com/waqiju/pi-session-manager`（或裸 `pi update` 更新全部）
> 刷新 clone 并重启 pi，否则一直跑旧代码。（2026-09-15 实例：Ctrl+N 修复已推送但“无效”，
> 查得 clone 落后 4 个提交。）

## 触发点

| pi 事件 | 作用 |
|---------|------|
| `session_start` | 补漏：crash / kill -9 后恢复时追上 |
| `agent_settled` | live 转换（防抖，见 `PI_GARDEN_LIVE_INTERVAL_S`） |
| `session_compact` | compaction 章节边界 |
| `session_shutdown` | 终态保证；quit / new / resume / fork / reload 均触发 |

所有触发共享 `processFile` 的增量判断（mtime + `GARDEN_VERSION`），重复触发近零成本。
ephemeral session（无 session 文件）静默跳过；非常规路径布局（不在 `.../sessions/<sub>/` 下）静默跳过。

## 命令

| 命令 | 作用 |
|------|------|
| `/garden` | 快速 session 选择器（等位 /resume，见下节） |
| `/gardener-output` | 立即转换当前 session，notify 结果 |
| `/gardener-output all` | 全量回填整个 sessions 树（等价 CLI 目录模式） |
| `/gardener-open [lN]` | 默认浏览器打开当前 session 的 garden md；默认取存在的最高级别（l3>l2>l1>l0），可指定级别；无产物时先转换再开（指定的级别不在默认导出集时，按需只生成该级别） |

## /garden 快速选择器

等位内建 /resume（fork 树 / 搜索 / 改名 / 删除 / scope 切换），但**自绘组件 + md 数据源**，
慢盘（drvfs）上比内建快一个数量级。两个设计点：

### 自绘组件（extensions/garden-selector.ts）

不用 pi 的 `SessionSelectorComponent`：其 `buildSessionTree` 对每个 session 调 3 次
`canonicalizePath`（= `realpathSync`），而 `~/.pi/agent/sessions` 是 drvfs symlink 时
单次 ~23ms —— 315 session 首次渲染 ≈22s，且**搜索清空 / 切 scope / 增删后重付**，
每按键渲染还有 ~230ms 的当前行判定开销（pi 0.85.1 实测）。本组件零 `realpathSync`：
fork 树按 jsonl 文件名（basename）配对（`src/session-tree.ts`，文件名含 uuid 全局唯一，
跨路径风格——symlink / Windows 反斜杠遗留——都能配对），当前 session 高亮是字符串比较。
零运行时 pi 依赖（theme / keybindings 由 `ctx.ui.custom` 工厂注入结构化接口），
node --test 可直测（test/garden-selector.test.ts）。

### md 数据源（src/session-list.ts）

只读 garden 产物，不再读 jsonl（假设转换常驻、产物最新）：

- 每个 base 取最优级别（l3 > l2 > l1 > l0，与默认导出级别对齐），一次有界读（正文上限 1MB，仅 frontmatter 时 4KB）；
  frontmatter 提供 id / cwd / started / ended / name / messages 计数 / `source`（jsonl 文件名）
  / `parent_session`（fork 链）；正文提供 firstMessage（首个 `## 🙋 User` 小节）与
  allMessagesText（全文搜索语料，`PI_GARDEN_SELECTOR_FULLTEXT=0` 关闭）。
- jsonl 路径由 `<sessionsRoot>/<sub>/<source>` 重建；选中时才 `existsSync` 校验
  （列表期不查，315 次 syscall ≈7s 不值得）；jsonl 已删 → notify（md 归档仍在）。
- 无 `source` 字段的旧版产物跳过——升级后跑一次 `/gardener-output all` 回填即全量出现。
- 同 session 多份产物（改名/重编号残留）去重：新命名风格优先，同风格取 mtime 新者。

### 与内建的功能差异

保留：fork 树（threaded）、搜索（fuzzy token / `"phrase"` 精确 / `re:` 正则，语法同内建）、
Tab scope（current/all 都缓存，二次切换零开销）、Ctrl+R 改名（`SessionManager.appendSessionInfo`
同路径 + 立即重转 md 同步新名）、Ctrl+D 删除（trash 优先回退 unlink 删 jsonl；按 frontmatter
session_id 清全部 md 产物；内存移除，**不做内建那样的全量重载**）。
新增：Ctrl+N 新建子会话（`ctx.newSession({ parentSession })`；内建选择器已无此键——pi 0.85.1
把 ctrl+n 默认绑定挪给了 `app.session.toggleNamedFilter`）。匹配走 `isCtrlN`（garden-selector.ts）：
直接认物理键，legacy `\x0e` / Kitty CSI-u `\x1b[110;5u` / modifyOtherKeys `\x1b[27;5;110~`
三编码全覆盖（pi-tui 会协商 Kitty flags=7，终端编码不保证是 legacy）；**不借** `kb.matches`
的 action 名——上游改绑默认键已坑过一次。
裁剪：sort 三模式循环、named-only 过滤、path 显示开关（threaded + 搜索已覆盖）。
回退：`PI_GARDEN_SELECTOR=builtin` 可切回官方组件（对比/排查用，drvfs 上会卡）。

### 实测（本机 drvfs，315 session）

| 指标 | 内建组件 + 内建 loader | garden 自绘组件 |
|------|----------------------|----------------|
| 首次可用 | ~22s+（canonicalizePath 风暴） | 0.4-0.5s（current）/ 1.4s（all） |
| 搜索按键 | 每次渲染 ~230ms（isCurrent canonicalize）；清空搜索重付 22s | <50ms |
| 切 scope（已加载） | 重付 22s | <5ms（缓存） |

验证：`node scripts/probe-selector.mjs`（headless，真实数据 + 按键驱动 + 性能预算断言）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_GARDEN` | `1` | `0` = 完全停用扩展（不注册任何事件/命令） |
| `PI_GARDEN_LEVELS` | `l1,l3` | 导出级别（逗号分隔，子集 `l0/l1/l2/l3`，大小写不敏感；全部非法回退默认）。l0 与源 jsonl 冗余、l2 语料与 l3 重叠，默认不导；旧配置产出的其他级别文件按归档语义保留，不会自动清理 |
| `PI_GARDEN_LIVE_INTERVAL_S` | `60` | live 触发最小间隔（秒，可小数）；`0` = 关闭 live 触发 |
| `PI_GARDEN_OPEN_CMD` | 平台默认 | 自定义打开命令；空格切分，含 `{file}` 替换否则追加为末参。平台默认：WSL `wslpath -w` + `cmd.exe /c start`，Linux `xdg-open`，macOS `open` |
| `PI_GARDEN_SELECTOR_FULLTEXT` | `1` | `/garden` 选择器用 garden md 正文作全文搜索语料；`0` = 关闭（退回只搜 id/name/cwd） |
| `PI_GARDEN_SELECTOR` | 自绘组件 | `builtin` = 退回 pi 官方 SessionSelectorComponent（对比/排查用；drvfs 上会卡） |

## 行为细节

- **成功路径静默**：自动触发不 notify；失败仅 notify 一次（相同错误去重，防 live 刷屏）。
- **不阻塞主流程**：转换是同步 CPU 工作（最大 session ≈0.5s），但所有事件处理器内失败只告警。
- **与 CLI 无冲突**：同一套增量判断；扩展管当前 session，CLI / `/garden all` 管全量。

## 相关

- 模块全景：wiki/internals/concepts/system-map.md
- 扩展导出函数：wiki/internals/reference/api.md（`extensions/garden.ts` 一节）
- 增量语义：wiki/internals/reference/cli.md
