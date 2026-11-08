# 启动文件驱动的 PSM 会话

## Before You Begin

- 完整安装、升级与卸载流程见仓库根目录 [install.md](../../../install.md)。
- 使用 Linux、WSL 或 macOS，安装 Node.js >= 22.19 和 Pi >= 1.5。
- 在仓库执行 `npm install --ignore-scripts --legacy-peer-deps`。
- 执行 `npm link --ignore-scripts --legacy-peer-deps` 安装全局 `psm` / `garden` 命令；也可直接 `node /path/to/repo/src/psm/cli.ts`。
- 在 `~/.psm/config.json` 或项目 `.psm/config.json` 配置默认模型表达式；模型 endpoint 和认证参见 [配置参考](../reference/psm.md)。不会自动使用全局 Pi 认证。

## Steps

1. 进入希望模型操作的工作目录。建议将 `.psm/` 加入该项目 `.gitignore`。
2. 启动：`psm deepseek "分析当前项目结构"`。记录返回的 run ID 和目录。
3. 等待 `001.status.json` 为 `completed`，打开 `001.out.md`；frontmatter 指出本轮在 L1 中的行范围。执行 `psm open 1` 可用系统默认应用打开 L3 问答归档，`--level l1` 打开完整过程（这里假设 run ID 为 `000001`）。
4. 执行 `psm 1 "继续分析"`（等同于 `psm prompt 1 "继续分析"`），或 `psm 1 --file ./prompt.md` 提交多行文本。命令自动分配下一轮编号，执行中则排队。也可手工创建 `002.tmp`，写完后重命名为 `002.in.md`，连续编号直到 `999.in.md`。
5. 执行 `psm list` 或 `psm status <run-id>` 查询状态。
6. 不再需要后续交互时执行 `psm stop <run-id>`。连续空闲且无排队输入满 24 小时也会自动停止，文件保留；`idleTimeoutMs: 0` 可关闭自动停止。
7. 需要恢复时执行 `psm restart <run-id>`，再用 `psm prompt <run-id> "检查已有结果，然后继续"` 提交下一轮。restart 恢复原会话，跳过中断轮次；尚未开始的排队输入会自动继续执行，返回信息列出恢复时的队列。

## Verify

- `psm status` 的 cwd 是启动目录，存储目录位于该 cwd 的 `.psm/runs/`。
- `001.out.md` 包含最终答复，`session.l1.md` 和 `session.l3.md` 包含对话。
- 新增 `002.in.md` 后只有对应 `002.out.md` 生成，不重复执行 `001.in.md`。
- 停止后状态为 `stopped`、alive 为 false；自动停止的 `stopReason` 为 `idle_timeout`。
- `psm status` 的 `lastTurnStatus` 提供最近结束轮次的结果，`idleSince` 是本次空闲起始时间。
- restart 后 ID、cwd、会话路径不变，`restartCount` 增加；新 prompt 使用后续编号，历史轮次不会重复发送。

## Troubleshooting

- 模型选择失败：检查命令行表达式或 `defaultModel`，有歧义时使用 `provider/model`；不使用 Pi TUI 默认模型。旧 `config.json.models` 别名表需删除并迁移为表达式。
- 认证失败：检查 PSM 的 `models.json` / `auth.json` 或启动进程继承的 provider 环境变量。
- 实时查看：`psm logs 1` 默认显示最近 100 行事件转换后的纯文本，并持续跟随；`--format json` 查看原始事件，`--no-follow` 只查看当前尾部。Ctrl+C 退出查看器，后台 run 继续执行。
- 启动失败：查看返回目录下 `logs/stderr.log`、`run.json.error`，确认 piCommand 和 Pi 版本。
- 输入无响应：当前仅支持 `.in.md`，不兼容旧 `.in`，开发期旧 run 请重新创建。检查编号是否连续、文件是否为空、run 是否存活；排队输入要等待前一轮结束。
- 没有 `.out.md`：先看该轮 `.status.json`；failed / aborted / interrupted / handled 都可能没有文本输出。
- 归档缺失：查看 `run.json.archiveError`。模型答复成功与归档成功分别记录。
- worker 强制退出或机器重启：run 会呈现 interrupted。检查 session 中已经发生的操作，再执行 `psm restart`；残留的 running 轮次会整理为 interrupted 并跳过，不自动重放。会话文件缺失、损坏或轮次检查点缺失时恢复会报错，应先修复数据。
- restart 提示旧进程仍在：心跳过期不等于退出。检查实际 worker / Pi 进程，确认退出后再恢复；命令不会向历史 PID 发送信号。
- 提示 control.lock 被占用：另一个 prompt/stop/restart 可能尚未完成。若持锁进程被强杀或机器重启导致锁遗留，查看 `control.lock/owner.json`，确认所属进程已退出后删除该锁目录再重试。不要仅凭锁的年龄删除；无 owner.json 的锁也需确认没有并发控制命令。
- 单轮 failed / aborted 但 run 仍 idle：直接提交下一条 prompt，无需 restart。
- stop 尚未确认：继续查询 status 和日志，不手工复用旧 PID。

## Related

- [PSM CLI 与配置](../reference/psm.md)
- [架构、隔离与状态](../concepts/psm.md)
- [已有 garden 转换流程](run-conversion.md)
