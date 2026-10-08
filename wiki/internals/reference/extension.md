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
| `session_info_changed` | 会话 metadata 变更（如 `/name` 改名）；改名会更新文件名 slug，旧文件由增量清理删除 |

所有触发共享 `processFile` 的增量判断（mtime + `GARDEN_VERSION`），重复触发近零成本。
ephemeral session（无 session 文件）静默跳过；非常规路径布局（不在 `.../sessions/<sub>/` 下）静默跳过。

## 命令

| 命令 | 作用 |
|------|------|
| `/garden` | 快速 session 选择器（等位 /resume，见下节） |
| `/gardener-output` | 立即转换当前 session，notify 结果 |
| `/gardener-output all` | 全量回填整个 sessions 树（等价 CLI 目录模式）；收尾重建有变化目录的 index.md |
| `/gardener-output index` | 重建当前项目 garden 目录的 index.md（不转换） |
| `/gardener-open [lN]` | SSH 下输出网页预览 URL，非 SSH 下用默认浏览器打开 md；**打开前必定增量转换**（isUpToDate 三项比对，新鲜时近乎零成本），以写路径返回的真实文件名定位——不自算文件名（单 session 组重算序号恒 001，撞 slug 会开错文件；2026-09-24 实例）；默认取存在的最高级别（l3>l2>l1>l0），可指定级别（不在默认导出集时按需只生成该级别）；转换失败则 open 失败，不做只读兜底 |
| `/gardener-open index` | 重建当前项目目录的 index.md 并用默认浏览器打开（打开前总是重建，保证看到最新） |

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
把 ctrl+n 默认绑定挪给了 `app.session.toggleNamedFilter`）、Ctrl+Y 复制子树到剪贴板
（粘贴给其他 AI 作 context，格式为目标 AI 优化：自解释头部说清 fork 语义与级别规则；
树行内联 `[n] 名称 — msgs · size · 日期`，无名节点回退首条消息摘要；同编号绝对路径清单
——不用 `~`，部分读文件工具不展开。每个 session 取实际存在的最高级别 md；>99 硬拒；
平台剪贴板使用 Pi 公开 `copyToClipboard` API（动态加载、异步），本地走原生能力，
SSH/MOSH 下发送 OSC 52 到客户端终端，无客户端助手。选择器复制期间防重复触发，
异常给 toast；dispose 后不再更新 UI。远程成功提示仅为“已发送复制请求”，不能验证终端
是否支持/允许 OSC 52（tmux 也需允许传递）。Base64 >100,000 字符预先拒绝，避免 Pi
只写远程原生剪贴板却被误判为客户端成功；不截断内容。复制的绝对路径仍在运行 pi 的机器。
`buildSubtreeCopyText` 可直测）、
**Ctrl+G 反向同步**：把人工编辑过的 index.md（调缩进换父 / 行尾 `to-delete` / `to-archive`）
应用回 sessions——先一一对账（数量 + id），确认条汇总 N 换父 · M 删除 · K 归档后执行；
归档挪 jsonl 到 `1_archived/`（header 加 archivedTreePath/archivedAt，pi 容忍额外字段）。
语义与安全前提见 [reverse-sync](../concepts/reverse-sync.md)。
自有快捷键匹配走 `isCtrlLetter`（garden-selector.ts）：直接认物理键，legacy 控制字符 /
Kitty CSI-u / modifyOtherKeys 三编码全覆盖（pi-tui 会协商 Kitty flags=7，终端编码不保证
是 legacy）；**不借** `kb.matches` 的 action 名——上游改绑默认键已坑过一次，且 pi 的
KeybindingsManager 不认扩展自定义 action（用户 keybindings.json 无法补绑）。
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
| `PI_GARDEN_OPEN_MODE` | `auto` | auto：检测 SSH_CONNECTION/SSH_CLIENT 后输出网页预览 URL，否则本地打开；web/local 强制覆盖（tmux 环境继承可能导致自动检测不准） |
| `PI_GARDEN_PREVIEW_PORT` | `13322` | 网页预览固定端口（1–65535）；客户端需 SSH -L 转发同一端口，冲突明确报错，不自动换端口 |
| `PI_GARDEN_OPEN_CMD` | 平台默认 | 仅本地打开模式生效。 自定义打开命令；空格切分，含 `{file}` 替换否则追加为末参。平台默认：WSL `wslpath -w` + `cmd.exe /c start`，Linux `xdg-open`，macOS `open` |
| `PI_GARDEN_SELECTOR_FULLTEXT` | `1` | `/garden` 选择器用 garden md 正文作全文搜索语料；`0` = 关闭（退回只搜 id/name/cwd） |
| `PI_GARDEN_SELECTOR` | 自绘组件 | `builtin` = 退回 pi 官方 SessionSelectorComponent（对比/排查用；drvfs 上会卡） |

## SSH 网页预览

客户端以 `ssh -L 127.0.0.1:13322:127.0.0.1:13322 <host>` 连接。
远程 `/gardener-open [lN]` 或 `index` 先按原流程生成最新 md，再输出独占一行的
`http://localhost:13322/r<根目录摘要>/...`，由人类点击/复制到客户端浏览器。
不启动远程浏览器，也不验证客户端是否已完成转发。Windows Chrome 访问 WSL localhost
转发需客户端网络配置支持；终端不支持 URL 点击时复制即可。

`src/preview.ts` 使用 Node HTTP + markdown-it，首次命令才监听 `127.0.0.1`。
服务只读已注册 garden 根目录内的 `.md`；不列目录、不提供 jsonl，realpath 校验防路径
越界（garden 根目录本身可以是软链）。无访问令牌，仅用于可信本机 / SSH 转发环境；
任何能连接端口的人都可读取已注册根目录中的 md，不要转发监听到公共网络。
响应包含 `X-Garden-Preview: 1`，错误正文以 `Garden preview:` 开头，便于辨认转发是否
连接了正确服务；缺文件 404、无读取权限 403、渲染异常 500。HTML 原文关闭，嵌入图片不加载，
CSP 禁用脚本与外部资源。相对 md 链接自动沿同一 URL 路径跳转；frontmatter 不显示。
页面 no-store，每次刷新读最新 md；单文件上限 32MiB。

new/resume/fork 保留服务和已有链接；多个 pi 共用服务，首个成功绑定端口的 pi 是宿主，
其他 pi 通过 `/_garden/health` 验证协议 `garden-preview-v2`，再通过 `/_garden/register`
POST 注册真实 garden 根目录和目标 md。注册仅接受 JSON 和自定义协议头，拒绝浏览器
Origin 请求；这是可信本机控制接口，不是认证边界，不应暴露到公共网络。
根目录 ID 使用真实路径 SHA-256 的前 16 位，不依赖进程注册顺序，避免 r0 指向不同目录。

宿主 quit/reload 关闭 socket；借用者 quit/reload 不关闭宿主。任意 pi 下次 open 时
重新尝试绑定端口，宿主不存在则接管；并发竞争以端口绑定为准，失败者验证并复用赢家。
接管后只恢复再次注册过的根目录，同根目录文档原 URL 可重新使用。HTTP server unref，
不阻止宿主进程退出；不产生后台进程。占用者不是兼容服务（含旧版 garden）时明确报错，
不盲目复用，不自动换端口。网页预览不改 session 或 md 内容，
因此不 bump GARDEN_VERSION。

## 行为细节

- **成功路径静默**：自动触发不 notify；失败仅 notify 一次（相同错误去重，防 live 刷屏）。
- **不阻塞主流程**：转换是同步 CPU 工作（最大 session ≈0.5s），但所有事件处理器内失败只告警。
- **与 CLI 无冲突**：同一套增量判断；扩展管当前 session，CLI / `/garden all` 管全量。
- **index.md 重建边界**：live 自动转换（settle/shutdown 等）**不**重建目录索引——避免每次
  settle 全目录 frontmatter 扫描；`/gardener-output all` 收尾会重建有变化的目录；
  `/gardener-open index` 打开前必重建。因此编辑器里直接浏览到的 index.md 可能滞后于最新会话，
  但打开路径永远最新（生成逻辑与格式见 src/index-page.ts 头注）。
- **live 编号避让**：live 转换是单 session 组，`planBaseNames` 永远给当日 001；撞车（同 slug
  兄弟已占用）时递增序号避让，**永不覆盖别的 session 的文件**；序号短暂不准由下次
  `/gardener-output all`（或 CLI）归位——全量路径整组编号，不需要避让。
- **全量路径自净**：`/gardener-output all` 与 CLI 目录模式共用 `convertGroup`（按子目录分组
  编号 + `removeStaleOutputs` 清旧命名；删除前复核文件当前归属，重编号交接不误删）。

## 相关

- 模块全景：wiki/internals/concepts/system-map.md
- 扩展导出函数：wiki/internals/reference/api.md（`extensions/garden.ts` 一节）
- 增量语义：wiki/internals/reference/cli.md
