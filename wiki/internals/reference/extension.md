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
| `/garden` | 立即转换当前 session，notify 结果 |
| `/garden all` | 全量回填整个 sessions 树（等价 CLI 目录模式） |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_GARDEN` | `1` | `0` = 完全停用扩展（不注册任何事件/命令） |
| `PI_GARDEN_LIVE_INTERVAL_S` | `60` | live 触发最小间隔（秒，可小数）；`0` = 关闭 live 触发 |

## 行为细节

- **成功路径静默**：自动触发不 notify；失败仅 notify 一次（相同错误去重，防 live 刷屏）。
- **不阻塞主流程**：转换是同步 CPU 工作（最大 session ≈0.5s），但所有事件处理器内失败只告警。
- **与 CLI 无冲突**：同一套增量判断；扩展管当前 session，CLI / `/garden all` 管全量。

## 相关

- 模块全景：wiki/internals/concepts/system-map.md
- 扩展导出函数：wiki/internals/reference/api.md（`extensions/garden.ts` 一节）
- 增量语义：wiki/internals/reference/cli.md
