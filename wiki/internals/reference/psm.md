# PSM CLI 与文件协议

## CLI

```bash
psm <model-alias> "首条 prompt" [--group research] [--json]
psm "首条 prompt"                       # config.defaultModel
psm list [--all] [--group research] [--json]
psm status <run-id>
psm stop <run-id>
psm --help
```

prompt 必须作为一个参数传入；以 `-` 开头时用 `--` 结束选项解析。`list`、`status`、`stop` 是保留子命令，不能作为无模型参数时的单独 prompt；可显式指定模型别名消除歧义。

默认 `list` 显示最近 24 小时有活动的 run，加上所有仍存活的 run；`--all` 显示全部注册历史。注册表跨 cwd，位于 `~/.psm/registry/`。已删除 run 目录的记录跳过。status/stop 支持唯一 ID 前缀。status 输出 JSON；stop 最多等待 10 秒，超时返回非零并提示停止请求尚未确认。

启动命令在 worker 和 Pi 就绪后返回 run ID、目录和首轮结果路径；不会向终端输出模型回答。启动失败返回非零并提供 run 目录。命令成功只表示后台就绪，后续模型错误见轮次状态。

## 配置优先级

`~/.psm/` → `<cwd>/.psm/`。不向父目录搜索 `.psm`。`PSM_HOME` 可以替换全局目录，用于独立安装或测试；当前目录的 run 存储位置不受影响。

两个目录都可包含：

- `config.json`：PSM 配置。
- `models.json`：Pi 原生模型/provider 配置。
- `auth.json`：Pi 原生认证配置；可选，也可使用 provider 环境变量。

`config.json` 和 `auth.json` 对象字段递归合并，本地覆盖全局，数组整体替换。`models.json` 不合并、不复制：优先整文件使用当前目录版本，否则使用全局版本；本地文件无效时直接报错，不回退。两处都不存在时使用 Pi 内置模型及现有认证。run 的 `agent/models.json` 是指向选定源文件的绝对符号链接，不保存含 API key 的副本或快照。修改源文件会影响后续加载，既有进程是否重新加载取决于 Pi。历史 run 的副本不自动迁移。

`config.json` 示例：

```json
{
  "defaultModel": "deepseek",
  "models": {
    "deepseek": {
      "provider": "deepseek",
      "model": "deepseek-chat"
    }
  },
  "piCommand": ["pi"],
  "pollMs": 500,
  "stableMs": 1000,
  "startupTimeoutMs": 30000,
  "turnTimeoutMs": 3600000
}
```

模型别名必需且精确映射；不把别名当作 Pi 的 fuzzy model pattern。运行时再次核对 Pi 返回的 provider/model。可选 `thinking` 取值：`off|minimal|low|medium|high|xhigh|max`，最终支持程度由 Pi/模型决定。

`piCommand` 是可执行文件与前置参数的 argv 数组，不经过 shell。默认使用 PATH 中的 `pi`；也可配置 `["/absolute/path/to/pi"]` 或 `["node", "/absolute/path/to/pi/cli.js"]`。不要在 argv 中放凭据。未知配置字段会报错。

所有时长单位为毫秒，必须是 >= 10 的整数。`startupTimeoutMs` 也用于 RPC 命令接受响应超时。`turnTimeoutMs` 限制整轮执行，默认一小时，超时后停止该 run 并标记未确认结果，不自动重试输入。

例如通过 PSM 配置兼容 endpoint：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-chat" }]
    }
  }
}
```

将其保存为 `.psm/models.json`，并在启动 PSM 的环境中设置相应变量。具体 endpoint 和 model ID 应按实际 provider 核对；本仓库测试不调用该外部服务。

## Run 目录

新 run ID 固定六位，从 `000001` 递增到 `999999`，超过上限报错。同一 `PSM_HOME` 下跨 cwd/group 唯一；`ids/` 中的永久原子占位保证并发不冲突，启动失败或删除 run 后也不复用编号，不应删除占位。旧 UUID run 保持可用；查询先匹配完整 ID，再匹配唯一前缀。

`psm list` 按创建时间倒序输出对齐表格，包含 ID、状态、存活情况、group、模型、最近轮次和更新时间。长字段按终端宽度截断；完整目录见 `psm status`，完整机器输出用 `--json`。

```text
.psm/runs/<group>/<six-digit-id>/
  run.json                  # 运行状态、cwd、有效 PSM 配置、PID、心跳
  worker.lock               # 永久独占声明；不支持同 run 重启
  agent/                    # 独立配置；models.json 为源文件的符号链接
  session.jsonl             # Pi 原生会话
  session.l1.md             # 完整会话的阅读归档
  session.l3.md             # 完整会话的问答归档
  001.in                    # 首轮 prompt
  001.out                   # 成功后的最终文本，可能为空
  001.status.json           # 轮次状态与输入 SHA-256
  002.in                    # 下一轮 prompt
  logs/
    events.jsonl            # 原始 RPC 响应和事件
    stderr.log              # Pi/worker 诊断
  stop.json                 # 停止请求，由 psm stop 生成
```

用户只应新增下一编号的 `.in`。其他文件由 PSM/Pi 管理。

## 输入发布与结果

1. 编号从 `001` 开始，连续到 `999`；遇到缺号等待，非法编号如 `000.in`、`1000.in` 使 run 失败。
2. 首条 prompt 由 CLI 写入 `001.in`。后续建议写 `002.tmp`，写完后原子重命名为 `002.in`。
3. worker 定期扫描，不依赖 `fs.watch`，适用于 WSL drvfs；内容摘要保持不变达到 `stableMs` 后消费。空白输入等待补全。
4. 直接编辑 `.in` 受稳定窗口保护，但无法保证识别长时间暂停的编辑；需要明确提交边界时使用临时文件 + rename。
5. 一次只有一轮在执行，后续文件排队；不会把新文件作为 steering 注入当前轮。
6. 已消费的编号不会重新执行，修改旧 `.in` 不改变已提交输入。状态保存的是发送时文本摘要，session 保存模型实际收到的内容。
7. `.out` 原子写入后再更新状态为 `completed`；轮次失败/取消/中断不生成 `.out`。L1/L3 在每轮结束及退出时刷新，使用稳定文件名。

输入 `.in` 必须是普通文件，不接受符号链接。协议以文本 prompt 为主，不把 `@file` 自动展开为附件；Pi RPC 本身也不接受 CLI `@file` 参数。

## 测试

```bash
npm test
# 可选：真实 Pi + 本地模拟模型 API，无外部凭据或费用
PSM_REAL_PI=/absolute/path/to/pi node --test test/psm-real-pi.test.ts
```

默认回归使用模拟 RPC 子进程，真实 Pi 集成测试未设置变量时跳过。macOS 使用相同 POSIX 实现，但是否完成实机验证见发布说明。

## 相关

- [设计和状态机](../concepts/psm.md)
- [首次使用](../tasks/run-psm.md)
