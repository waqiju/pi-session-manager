# Extension 字典（extensions/garden.ts）

pi 扩展形态：会话生命周期内自动把**当前 session** 转成三级 markdown。
渲染核心在 `src/`（与 CLI 同源），扩展只做事件接线，因此输出、增量语义与 CLI 完全一致。

## 安装

| 方式 | 命令 | 适用 |
|------|------|------|
| 本地路径 | `pi install /path/to/pi-session-manager` | 开发期；不拷贝，改完 `/reload` 即生效 |
| git package | `pi install https://github.com/waqiju/pi-session-manager` | 稳定后分发 |
| 临时试用 | `pi -e /path/to/pi-session-manager` | 单次运行 |

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
| `/gardener-open [lN]` | 默认浏览器打开当前 session 的 garden md；默认取存在的最高级别（l3>l2>l1>l0），可指定级别；无产物时先转换再开 |

## /garden 快速选择器

与内建 /resume **同一个 UI 组件**（`SessionSelectorComponent`，pi 公共导出），fork 继承树
（threaded）、搜索框、Ctrl+D 删除（trash）、重命名、scope/sort 切换全部等位。
唯一差别是数据源（`src/session-list.ts`）：

- **每个文件只做一次有界读**（首 64KB）：首行 header（id / cwd / timestamp /
  `parentSession` fork 链）+ 缓冲内顺带取首条 user 消息与 session_info 名；
  `modified` 用 stat.mtime 近似。内建则逐行读完整个 jsonl，慢盘（drvfs）上数百个
  session 差距显著（本机 309 个 / 138.7MB：快速列表 2.0s vs 内建式全读 1.5s 温缓存，
  冷缓存 / 更慢的盘差距放大，字节量差 6.6 倍）。
- **garden frontmatter 富化**：自动转换常驻产出 md，选择器读 l2 frontmatter 回填
  name / messageCount（本机命中率 286/309）。
- **已知取舍**：不建 allMessagesText，全文搜索不可用（id / name / cwd 可搜）；
  未转换且无名的 session 显示为空标题（时间/fork 位置仍可辨认）。
- 选中后 `ctx.switchSession(path)`；cwd 缺失的跨机器 session 会报错 notify
  （内建的 cwd 重选流未暴露给扩展）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_GARDEN` | `1` | `0` = 完全停用扩展（不注册任何事件/命令） |
| `PI_GARDEN_LIVE_INTERVAL_S` | `60` | live 触发最小间隔（秒，可小数）；`0` = 关闭 live 触发 |
| `PI_GARDEN_OPEN_CMD` | 平台默认 | 自定义打开命令；空格切分，含 `{file}` 替换否则追加为末参。平台默认：WSL `wslpath -w` + `cmd.exe /c start`，Linux `xdg-open`，macOS `open` |

## 行为细节

- **成功路径静默**：自动触发不 notify；失败仅 notify 一次（相同错误去重，防 live 刷屏）。
- **不阻塞主流程**：转换是同步 CPU 工作（最大 session ≈0.5s），但所有事件处理器内失败只告警。
- **与 CLI 无冲突**：同一套增量判断；扩展管当前 session，CLI / `/garden all` 管全量。

## 相关

- 模块全景：wiki/internals/concepts/system-map.md
- 扩展导出函数：wiki/internals/reference/api.md（`extensions/garden.ts` 一节）
- 增量语义：wiki/internals/reference/cli.md
