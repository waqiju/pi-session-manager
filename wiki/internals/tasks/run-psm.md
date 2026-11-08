# 启动文件驱动的 PSM 会话

## Before You Begin

- 使用 Linux、WSL 或 macOS，安装 Node.js >= 22.19 和 Pi >= 1.5。
- 在仓库执行 `npm install --ignore-scripts --legacy-peer-deps`。
- 执行 `npm link --ignore-scripts --legacy-peer-deps` 安装全局 `psm` / `garden` 命令；也可直接 `node /path/to/repo/src/psm/cli.ts`。
- 在 `~/.psm/config.json` 或项目 `.psm/config.json` 配置模型别名；模型 endpoint 和认证参见 [配置参考](../reference/psm.md)。不会自动使用全局 Pi 认证。

## Steps

1. 进入希望模型操作的工作目录。建议将 `.psm/` 加入该项目 `.gitignore`。
2. 启动：`psm deepseek "分析当前项目结构"`。记录返回的 run ID 和目录。
3. 等待 `001.status.json` 为 `completed`，打开 `001.out`；完整过程见 `session.l1.md`。
4. 在 run 目录创建 `002.tmp`，写入后续 prompt；保存完成后重命名为 `002.in`。继续使用 `003.in`，直到 `999.in`。
5. 执行 `psm list` 或 `psm status <run-id>` 查询状态。
6. 不再需要后续交互时执行 `psm stop <run-id>`。空闲 run 会保持进程存活，直到被停止；文件保留。

## Verify

- `psm status` 的 cwd 是启动目录，存储目录位于该 cwd 的 `.psm/runs/`。
- `001.out` 包含最终答复，`session.l1.md` 和 `session.l3.md` 包含对话。
- 新增 `002.in` 后只有对应 `002.out` 生成，不重复执行 `001.in`。
- 停止后状态为 `stopped`、alive 为 false。

## Troubleshooting

- 模型别名不存在：检查 `config.json.models`，不要直接依赖全局 pi 的默认模型。
- 认证失败：检查 PSM 的 `models.json` / `auth.json` 或启动进程继承的 provider 环境变量。
- 启动失败：查看返回目录下 `stderr.log`、`run.json.error`，确认 piCommand 和 Pi 版本。
- 输入无响应：检查编号是否连续、文件是否为空、run 是否存活；排队输入要等待前一轮结束。
- 没有 `.out`：先看该轮 `.status.json`；failed / aborted / interrupted / handled 都可能没有文本输出。
- 归档缺失：查看 `run.json.archiveError`。模型答复成功与归档成功分别记录。
- worker 强制退出：run 会呈现 interrupted，不能直接重启/重放。检查 session 中已经发生的操作后另开 run。
- stop 尚未确认：继续查询 status 和日志，不手工复用旧 PID。

## Related

- [PSM CLI 与配置](../reference/psm.md)
- [架构、隔离与状态](../concepts/psm.md)
- [已有 garden 转换流程](run-conversion.md)
