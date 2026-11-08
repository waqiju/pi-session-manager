# PSM 后台会话

PSM 1.0 在现有 garden 归档能力上增加 `psm` CLI。支持 Linux、WSL 和 macOS 的 POSIX 进程模型；原生 Windows 暂不支持。运行时需要 Node.js >= 22.19、Pi >= 1.5。garden 原有 CLI 与扩展继续可用。

## 结构

```text
psm CLI → detached worker（每 run 一个）→ pi --mode rpc
                   │                          │
                   ├─ 顺序读取 NNN.in         ├─ session.jsonl
                   ├─ NNN.out / status        └─ JSONL events
                   └─ archiveSession → session.l1.md / session.l3.md
```

CLI 等待 RPC `get_state` 成功、核对精确 provider/model 后返回；不等待首轮回答。worker 脱离启动终端，每个 run 独立，不需要全局 daemon。Pi 在调用 `psm` 时的 cwd 工作，数据存储在该 cwd 的 `.psm/runs/<group>/<uuid>/`。group 默认 `default`。

新增模块：

| 模块 | 责任 |
|---|---|
| `src/psm/cli.ts` | 启动、配置快照、注册 run、list/status/stop |
| `src/psm/config.ts` | 全局/本地配置合并、模型别名解析 |
| `src/psm/worker.ts` | 输入串行消费、状态机、RPC 事件、归档、终止 |
| `src/psm/rpc.ts` | 子进程、LF framing、请求关联、背压、关闭 |
| `src/psm/runs.ts` | 注册表、存活判定、状态读取 |
| `src/psm/files.ts` | 私有文件写入、原子替换、JSON I/O |
| `src/archive.ts` | 显式源文件和输出基名的 L1/L3 归档入口 |

PSM 不使用 garden 的旧目录推导和兄弟 session 重编号，也不自动接入 `/garden` 选择器。输出渲染器原样复用，未改变 garden 内容格式或 `GARDEN_VERSION`。

## 隔离

每个 run 的 `agent/` 保存合并后的 `models.json`、`auth.json` 和独立 `settings.json`，通过 `PI_CODING_AGENT_DIR` 传给 Pi；session 路径也显式指定。父会话的 `PI_SESSION_*`、模型标记被移除。

凭据只从 PSM 的 `auth.json`、`models.json` 或继承的 provider 环境变量解析；不读取或复制 `~/.pi/agent` 的凭据。Pi 的内置模型目录仍可使用，但 PSM 必须显式配置模型别名。运行配置与认证快照只对新 run 生效，既有 run 不热加载。

第一期关闭自动发现的 extensions、skills、prompt templates、themes 和 MCP，并忽略项目 `.pi` 的信任门控资源，防止全局插件隐式加入后台执行。Pi 的默认工具与调用 cwd 的 `AGENTS.md` 上下文仍生效。PSM 没有自定义 system prompt 配置。`--offline` 禁止 Pi 的自动模型目录更新等联网活动，不禁止模型 API 请求。

文件默认 0600，新建目录默认 0700；WSL 的 Windows 挂载盘实际权限取决于挂载配置。完整事件、session 和日志包含对话及工具数据，不作为脱敏日志。`run.json` 不嵌入 models/auth 凭据；不要把密钥放进 `piCommand` 参数。

## 状态与完成边界

run 状态：`starting → idle ↔ running → stopping → stopped`，异常终止为 `failed`。读取状态时发现活动 run 的心跳过期或 PID 消失，呈现 `interrupted`，不自动启动新 worker。

单轮状态：`running → completed | failed | aborted | handled | interrupted`。

- prompt response 只表示接受或拒绝，不代表推理完成。
- `agent_end` 后仍可能重试/压缩；以 `agent_settled` 收尾。
- 收集 `message_end` 中本轮最后一条 assistant 文本；重试后成功的消息替换之前的错误。
- 只有 `completed` 生成 `.out`；`failed` 的错误记录在 `.status.json`，`handled` 没有模型答复。
- 输出为空也可能成功，判断依据是状态文件。
- 归档失败单独写 `run.json.archiveError`，不把已经完成的模型答复标成失败。

worker 每秒更新心跳。存活判定同时检查活动状态、PID 存在、心跳新鲜度（至少 10 秒宽限）；它不是操作系统进程清单，无法列出非 PSM 启动的 Pi。全局注册表只保存 run ID 和路径，供跨 cwd 查询。

## 故障与停止

`psm stop` 写带 run token 的 `stop.json`，由 worker 消费，不直接向注册表里的历史 PID 发信号。worker 关闭 RPC stdin，最多等待 2 秒，然后向自己创建的 Pi 进程组发送 TERM，再等待 2 秒，必要时 KILL。SIGINT/SIGTERM 也进入该关闭流程。

正在执行的输入会标记 `interrupted`：已经发生的工具副作用不会回滚。进程被 SIGKILL、机器断电等情况下，磁盘上的轮次状态可能仍为 `running`，应结合 run 的 `interrupted` 状态判断。Pi 的 stdin 随 worker 退出关闭，但机器级/强制退出情况下不能保证所有工具子进程都完成清理。

每个 run 使用独占的 `worker.lock`；写执行状态先于发送 prompt。不会自动重启 run 或重放未确认输入，因此不承诺跨崩溃的 exactly-once 执行。需要人工检查已有 session/结果后另开 run。

## 相关

- [CLI、配置与文件协议](../reference/psm.md)
- [使用流程](../tasks/run-psm.md)
- [原有 garden 系统地图](system-map.md)
