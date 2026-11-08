# PSM 后台会话

PSM 1.0 在现有 garden 归档能力上增加 `psm` CLI。支持 Linux、WSL 和 macOS 的 POSIX 进程模型；原生 Windows 暂不支持。运行时需要 Node.js >= 22.19、Pi >= 1.5。garden 原有 CLI 与扩展继续可用。

## 结构

```text
psm CLI → detached worker（每 run 一个）→ pi --mode rpc
                   │                          │
                   ├─ 顺序读取 NNN.in.md         ├─ session.jsonl
                   ├─ NNN.out.md / status        └─ JSONL events
                   └─ archiveSession → session.l1.md / session.l3.md
```

CLI 等待 RPC `get_state` 成功并保存实际 provider/model/thinking 后返回；restart 核对已固定的选择；不等待首轮回答。worker 脱离启动终端，每个 run 独立，不需要全局 daemon。Pi 在调用 `psm` 时的 cwd 工作，数据存储在该 cwd 的 `.psm/runs/<group>/<six-digit-id>/`。group 默认 `default`。

新增模块：

| 模块 | 责任 |
|---|---|
| `src/psm/cli.ts` | 创建配置快照、注册 run、list/status/stop/restart/open/prompt/logs、数字 prompt 简写 |
| `src/psm/lifecycle.ts` | worker 启动、停止请求、恢复前校验、轮次对账及 restart |
| `src/psm/control.ts` | 控制锁、进程存活与启动身份检查 |
| `src/psm/pipeline.ts` | JS pipeline 加载/校验、资源继承、启动参数与恢复前内容摘要检查 |
| `src/psm/config.ts` | 全局/本地配置合并、模型表达式选择 |
| `src/psm/worker.ts` | 输入串行消费、状态机、RPC 事件、归档、终止 |
| `src/psm/rpc.ts` | 子进程、LF framing、请求关联、背压、关闭 |
| `src/psm/runs.ts` | 六位 ID 原子分配、注册表、存活判定、状态读取 |
| `src/psm/interaction.ts` | 并发 prompt 编号与原子发布、归档路径选择 |
| `src/psm/replies.ts` | 输出 frontmatter、按归档 entry 行号刷新详情定位 |
| `src/psm/logs.ts` | 事件尾部读取与只读跟随、text/JSON 输出，无 Markdown 渲染依赖 |
| `src/psm/table.ts` | 终端宽度自适应列表表格、本地秒级时间 |
| `src/psm/files.ts` | 私有文件写入、原子替换、JSON I/O |
| `src/archive.ts` | 显式源文件和输出基名的 L1/L3 归档入口 |

PSM 不使用 garden 的旧目录推导和兄弟 session 重编号，也不自动接入 `/garden` 选择器。输出渲染器增加可选 entry 行号回调，Markdown 内容格式未改变，因而不改变 `GARDEN_VERSION`。PSM 每轮记录发送前和完成后的 entry 索引边界，归档后刷新所有成功输出中的 L1 行号，避免重复 prompt 或 frontmatter 行数变化导致定位错误。

## 隔离

每个 run 的 `agent/` 保存合并后的 `auth.json` 和独立 `settings.json`；`models.json` 使用符号链接指向当前目录或全局源文件（本地优先，整文件选择，不合并或复制），通过 `PI_CODING_AGENT_DIR` 传给 Pi；session 路径也显式指定。父会话的 `PI_SESSION_*`、模型标记被移除。

模型凭据只从 PSM 的 `auth.json`、`models.json` 或继承的 provider 环境变量解析；不读取或复制源 Pi 的模型认证。Pi 的内置模型目录仍可使用，但 PSM 必须提供模型表达式或自己的 defaultModel。运行配置与认证快照只对新 run 生效。模型文件不保留快照，源文件修改会影响后续加载；已有 Pi 进程的重载时机由 Pi 决定。

普通启动关闭自动发现的 extensions、skills、prompt templates、themes 和 MCP，并忽略项目 `.pi` 的信任门控资源。Pi 的默认工具与调用 cwd 的 `AGENTS.md` 上下文仍生效。`psm run` 加载 JS pipeline：`inherit` 继承指定 agent 的资源配置和指令并在当前进程加载项目 `.pi` 资源；`isolated` 禁止自动发现和上下文文件，只加载显式资源。pipeline 可追加系统提示、选择工具和配置模型/PSM 参数。继承不复制源 Pi 的模型认证，PSM auth/models 规则保持有效。参见 [pipeline 使用说明](../tasks/psm-pipelines.md)。`--offline` 禁止 Pi 的自动模型目录更新等联网活动，不禁止模型 API 请求。

pipeline 首次执行的结果存入 run 元数据，restart 不执行 JS；启动和恢复前校验资源内容摘要。MCP/settings 等私有副本仅供本 run 使用，扩展和 package 保留原路径/依赖引用。摘要校验范围与依赖限制见使用说明。扩展 RPC 交互请求不能静默当作成功：PSM 取消 select/confirm/input/editor 并终止 run，扩展事件错误也记录为失败。

文件默认 0600，新建目录默认 0700；WSL 的 Windows 挂载盘实际权限取决于挂载配置。完整事件、session 和日志包含对话及工具数据，不作为脱敏日志。`run.json` 不嵌入 models/auth 凭据；不要把密钥放进 `piCommand` 参数。

## 状态与完成边界

run 状态：`starting → idle ↔ running → stopping → stopped`，异常终止为 `failed`。读取状态时发现活动 run 的心跳过期或 PID 消失，呈现 `interrupted`，不自动启动新 worker。`psm restart` 在确认旧进程退出后允许 `stopped / failed / interrupted → starting`；仍存活的进程即使心跳过期也不能恢复。

默认连续 idle 24 小时且没有待消费输入时停止，stopReason 为 idle_timeout；`idleTimeoutMs: 0` 禁用。idleSince 在进入 idle 时更新，心跳与查询不更新该时间，running 不受空闲超时影响。临时 control.lock 协调 CLI 发布与空闲停止判定，获得锁后再次检查队列；CLI 已成功发布的输入优先消费。手动写文件不参与控制锁，应避免在临近停止时发布并检查轮次状态。

单轮状态：`running → completed | failed | aborted | handled | interrupted`。

- prompt response 只表示接受或拒绝，不代表推理完成。
- `agent_end` 后仍可能重试/压缩；以 `agent_settled` 收尾。
- 收集 `message_end` 中本轮最后一条 assistant 文本；重试后成功的消息替换之前的错误。
- 只有 `completed` 生成 `.out.md`；`failed` 的错误记录在 `.status.json`，`handled` 没有模型答复。
- 输出为空也可能成功，判断依据是状态文件。
- 归档失败单独写 `run.json.archiveError`，不把已经完成的模型答复标成失败。

worker 每秒更新心跳。存活判定同时检查活动状态、PID 存在、心跳新鲜度（至少 10 秒宽限）；新记录还检查进程启动身份（Linux 使用 boot ID + start ticks，macOS 使用 ps 启动时间），PID 复用不代表旧进程仍在。restart 的进程退出检查不依赖心跳。它不是操作系统进程清单，无法列出非 PSM 启动的 Pi。完整事件与诊断写入 run 的 `logs/`。全局 `ids/` 的永久占位避免并发分配冲突及编号复用，旧 UUID 注册记录保持兼容。全局注册表只保存 run ID 和路径，供跨 cwd 查询。

## 故障与停止

`psm stop` 写带 run token 的 `stop.json`，由 worker 消费，不直接向注册表里的历史 PID 发信号。worker 关闭 RPC stdin，最多等待 2 秒，然后向自己创建的 Pi 进程组发送 TERM，再等待 2 秒，必要时 KILL。SIGINT/SIGTERM 也进入该关闭流程。

正在执行的输入会标记 `interrupted`：已经发生的工具副作用不会回滚。进程被 SIGKILL、机器断电等情况下，磁盘上的轮次状态可能仍为 `running`，应结合 run 的 `interrupted` 状态判断。Pi 的 stdin 随 worker 退出关闭，但机器级/强制退出情况下不能保证所有工具子进程都完成清理。

每次启动使用独占 `worker.lock` 和 generation token；写执行状态先于发送 prompt。restart 在 control.lock 内确认旧 worker / Pi / 启动进程已退出，校验 session 和连续轮次检查点，把遗留 running 记为 interrupted，再根据持久检查点恢复 lastTurn。旧 worker.lock 与 stop.json 仅在这些检查通过后更换；worker 启动时核对 token，防止过期启动请求领取新一代 run。启动宽限使用本次 startedAt，不使用最初 createdAt。

restart 保留原 run ID 和 session.jsonl，加载原上下文；已有终态轮次不重放，尚未发送的队列继续消费，无队列则等待 prompt。logs/restarts.jsonl 保存恢复前元数据。未开始的启动失败允许创建尚不存在的 session，丢失已有上下文或损坏的 session 会拒绝恢复。控制进程意外退出可能遗留 control.lock，需确认 owner.json 对应进程退出后人工移除；不根据超时自动抢占不确定的锁。

恢复不代表从工具中断位置续跑，也不承诺跨崩溃的 exactly-once 执行。检查单轮 status 的 completed 判断完成，文件已写出但检查点尚未完成时仍按 interrupted 处理。单轮模型 failed / aborted 通常回到 idle，可直接 prompt；只有 run 结束才需要 restart。

## 相关

- [CLI、配置与文件协议](../reference/psm.md)
- [使用流程](../tasks/run-psm.md)
- [原有 garden 系统地图](system-map.md)
