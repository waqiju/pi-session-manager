# PSM CLI 与文件协议

## CLI

```bash
psm <model-expression> "首条 prompt" [--group research] [--json]
psm "首条 prompt"                       # config.defaultModel
psm run web-search "搜索近期新闻" [--group research] [--json]
psm run web-search --file ./question.md
psm list [--all] [--group research] [--json]
psm status 1                           # 1 / 01 / 000001 均指向 000001
psm stop 1
psm restart 1 [--json]                 # 恢复原会话，不重放中断轮次
psm open 1                             # 系统默认应用打开 L3
psm open 1 --level l1
psm 1 "继续分析"                       # psm prompt 的数字 ID 简写
psm 1 --file ./prompt.md
psm logs 1                             # 默认 text，尾部 100 行事件后持续跟随
psm logs 1 --format json --lines 200
psm logs 1 --no-follow
psm prompt 1 "继续分析" [--json]
psm prompt 1 --file ./prompt.md [--json]
psm --help
```

prompt 必须作为一个参数传入；以 `-` 开头时用 `--` 结束选项解析。`list`、`status`、`stop`、`restart`、`open`、`prompt`、`logs`、`run` 是保留子命令，不能作为无模型参数时的单独 prompt；可显式指定模型表达式消除歧义。

默认 `list` 显示最近 24 小时有活动的 run，加上所有仍存活的 run；`--all` 显示全部注册历史。注册表跨 cwd，位于 `~/.psm/registry/`。已删除 run 目录的记录跳过。所有按 run 操作的命令接受 1～6 位数字简写，补齐六位后精确匹配；0 或超过六位的数字无效，数字不作前缀查询。历史非数字 ID 仍可用唯一前缀。status 输出 JSON；stop 最多等待 10 秒，超时返回非零并提示停止请求尚未确认。

启动命令在 worker 和 Pi 就绪后返回 run ID、实际 provider/model、thinking、目录和首轮结果路径；不会向终端输出模型回答。启动失败返回非零并提供 run 目录。命令成功只表示后台就绪，后续模型错误见轮次状态。

## JS pipeline

`psm run <name> <prompt>` 或 `psm run <name> --file <path>` 执行本地 `.psm/<name>/pipeline.mjs`，没有本地目录时查全局 PSM 目录。默认 `inherit` 继承指定 Pi agent 资源与项目资源；`isolated` 仅加载明确指定资源。模型认证仍由 PSM 配置提供。启动输出包含 pipeline 名称与模式，status 的 `pipeline` 保存解析后的配置与资源摘要。`--group` 优先于 pipeline group。

restart 不再执行 JS，资源摘要不匹配时拒绝恢复；两种模式不影响现有文件协议。附加系统提示、工具选择和完整字段参见 [pipeline 使用说明](../tasks/psm-pipelines.md)。普通 `psm "prompt"` 的加载行为不变。

## 打开归档与追加 prompt

`psm open 1` 默认打开 `session.l3.md` 问答归档，`--level l1` 打开完整过程。复用 garden 的本地系统打开器及 `PI_GARDEN_OPEN_CMD`；WSL 经 `wslpath` 转换后交给 Windows 默认应用，不保证是浏览器。启动命令在启动 worker 前创建两份初始 Markdown，包含首条 prompt 和等待结果提示，因此启动成功后可以立即打开。worker 在本轮结束时用实际会话归档替换初始文档；查看器是否自动显示更新取决于其文件重载能力。初始提示不代表实时状态，启动或归档失败时应查看 `psm status`。`open` 只打开已有文件，不触发转换，也不启动 SSH 网页预览服务；历史 run 或文件被删除等导致文件缺失时仍明确报错。停止后的 run 仍可打开归档。

`psm prompt 1 "文本"` 与 `psm prompt 1 --file ./prompt.md` 二选一。文件相对 CLI 当前目录解析，UTF-8 内容原样读取，不执行附件展开。空白 prompt 拒绝；以 `-` 开头的文本使用 `psm prompt 1 -- "-文本"`。命令返回已发布的轮次及输入/输出路径，`--json` 返回结构化结果；这只代表入队，不代表模型完成。

首参数为纯数字且带第二个位置参数或 `--file` 时，`psm 1 "文本"` / `psm 1 --file ./prompt.md` 等同于显式 `psm prompt`，也支持 `--json`。数字必须为 1～6 位且大于零；无效或不存在的 ID 直接报错，不回退创建 run。该形式下纯数字模型表达式让位给 run ID；单独 `psm "123"` 仍使用默认模型创建首条 prompt 为 `123` 的 run。

同一 run 的 CLI 提交通过 `control.lock/` 串行分配连续编号，并与停止请求、restart 和 idle 超时判定互斥。临时文件写完后以不覆盖目标的原子硬链接发布，最后移除临时文件。手工文件若抢先占用编号，命令报错而不覆盖；已有编号缺口需先修复。锁等待最多 5 秒；持锁进程意外退出可能遗留锁，查看 `control.lock/owner.json` 并确认所属进程已退出后才能删除该目录重试，不自动按锁年龄回收。仅接受存活的 idle/running run；running 时排队，不作 steering，不隐式恢复已停止的 run。与手动停止并发时，已发布输入也可能留在队列未执行，应检查状态。

## 终端实时日志

`psm logs <id> [--format text|json] [--lines 100] [--no-follow]` 只读 `logs/events.jsonl`，不连接或接管 Pi。默认 text；不解析 Markdown、不引入终端渲染依赖、不回退光标重绘。模型原文中的 Markdown 标记保留，终端控制字符过滤。

- text 输出 assistant 文本增量、工具开始/完成/失败摘要、重试与压缩状态。工具结果摘要最多 240 个字符，不打印累计工具进度快照；思考内容及原始工具参数可在 JSON 事件中检查。消息快照用于补全中途接入的文本，并避免结束事件重复输出。
- json 保留原始事件行；stdout 仅 JSONL，查看器诊断写 stderr。无效的完整 JSON 行跳过并提示，尚未写完的末行等待补齐。
- `--lines` 是非负整数，统一按源事件行计数，默认 100；text 转换后的显示行数可能不同。0 从当前文件末尾开始，只查看后续完整事件。尾部按块倒读，不加载全部历史，但单个大事件仍需完整读入；文本快照可能携带当前消息的较长前文。
- 默认持续跟随，idle 时等待下一轮；run stopped/failed/interrupted 后读完尾部退出。`--no-follow` 只读取当前快照。Ctrl+C 仅退出查看器，不停止后台任务。
- 200ms 轮询，支持 UTF-8 分块、文件替换与截断。源文件缺失时，活跃 run 继续等待；`--no-follow` 返回空输出。管道关闭时正常退出。

## 空闲停止与恢复

`idleTimeoutMs` 默认 `86400000`（24 小时），设为 `0` 禁用。从每次进入 idle 的 `idleSince` 起计时，心跳、status/list/open 不重置计时。只在没有正在执行的轮次、也没有更高编号的 `.in.md` 时停止；已有队列先消费。空白输入或缺号导致的等待也视为仍有待处理输入，需要修复输入后才能正常消费或自动停止。停止原因记为 `idle_timeout`，会话及结果文件保留。list 的 24 小时筛选与该超时独立：刚停止的 run 仍显示，停止超过 24 小时且无新状态更新后默认隐藏，`--all` 可查看。

`psm restart <id>` 仅接受 stopped / failed / interrupted。命令保留原 ID、目录、cwd、模型、配置和认证快照，通过原 `session.jsonl` 恢复上下文；环境变量来自本次 CLI，models.json 的符号链接仍指向原文件。旧配置快照缺少 idleTimeoutMs 时补 24 小时默认值。已经运行的旧版 worker 不会热更新，需停止后 restart 才使用新版逻辑。

恢复前验证旧 worker / Pi / 启动进程已退出，单纯心跳过期不会允许启动第二个 worker。新记录携带进程启动身份以区分 PID 复用；旧记录缺少身份时保守拒绝仍存在的 PID。成功领取后更换 token，清理旧停止请求及 worker 声明，记录本次 startedAt 和 restartCount，等待 Pi 就绪后返回。并发 restart 只有一个能启动；正常运行的 run 应先 stop。

- 已有终态轮次保留；崩溃残留 running 检查点改为 interrupted，保留输入摘要和诊断，不重新发送。
- 按检查点恢复 lastTurn，即使崩溃时 run.json 尚未记录最后完成轮次，也不会重复消费。
- 尚未开始的排队输入继续串行消费。命令输出 `pendingTurns`（恢复时的队列快照，不是实时剩余队列）；没有队列则进入 idle，等待 prompt。
- 恢复历史写入 `logs/restarts.jsonl`，含前次 run 元数据和排队轮次；lastTurnStatus 显示最近结束轮次，stopReason 区分 requested / signal / idle_timeout / error。
- 原会话缺失或损坏、执行检查点缺失时明确报错，不静默新建会话。尚未创建任何持久上下文的启动失败可重新启动。
- 恢复不自动重放中断轮次，不回滚副作用，不恢复被中断的工具进程。崩溃可能留下已写出的 `.out.md`，应以 `.status.json` 的 completed 为完成依据。

不提供 `continue` 别名；`restart` 管理进程与会话恢复，`prompt` 提交下一轮任务。

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
  "defaultModel": "deepseek/deepseek-chat",
  "piCommand": ["pi"],
  "pollMs": 500,
  "stableMs": 1000,
  "startupTimeoutMs": 30000,
  "turnTimeoutMs": 3600000,
  "idleTimeoutMs": 86400000
}
```

模型选择顺序为命令行表达式 → 合并后的 PSM `defaultModel`；均未提供时直接报错，不使用 Pi TUI 默认值。PSM 把表达式原样传给 Pi `--model`，支持精确 ID、ID/名称模糊匹配、`provider/model` 及 `:thinking` 后缀。Pi 负责匹配及歧义诊断；跨 provider 匹配会考虑认证配置，仍有歧义时需写明 provider。指定 provider 的未知 ID 可能由 Pi 作为自定义 ID 接受，就绪不代表远端 API 一定支持该模型。

`run.json.requestedModel` 保存输入表达式；RPC `get_state` 返回的实际 provider、model ID 与 thinking 保存到 `run.json.model`，首轮消费前落盘。启动输出和 list 显示实际模型，尚未解析时 list 显示 pending。restart 使用保存的精确模型和 thinking 并核对返回值；没有成功解析过的启动失败重试原表达式。历史 run 的模型记录继续可用。

`config.json.models` 别名映射已移除，残留该字段会报迁移提示。把旧别名对应的 `provider/model[:thinking]` 写入 `defaultModel` 和启动命令，再删除该字段；`models.json` 中的 provider 定义保持原样。thinking 支持值与实际生效级别由 Pi/模型决定，包括 `off|minimal|low|medium|high|xhigh|max`。

`piCommand` 是可执行文件与前置参数的 argv 数组，不经过 shell。默认使用 PATH 中的 `pi`；也可配置 `["/absolute/path/to/pi"]` 或 `["node", "/absolute/path/to/pi/cli.js"]`。不要在 argv 中放凭据。未知配置字段会报错。

所有时长单位为毫秒；idleTimeoutMs 必须是 >= 0 的整数，0 禁用空闲停止，其他时长必须是 >= 10 的整数。`startupTimeoutMs` 也用于 RPC 命令接受响应超时。`turnTimeoutMs` 限制整轮执行，默认一小时，超时后停止该 run 并标记未确认结果，不自动重试输入。

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

`psm list` 按创建时间倒序输出对齐表格，包含 ID、状态、存活情况、group、模型、最近轮次和更新时间。更新时间使用 CLI 所在机器的本地时区，显示为 `YYYY-MM-DD HH:mm:ss`（无毫秒）；元数据及 JSON 输出仍用原始 ISO 时间戳。长字段按终端宽度截断；完整目录见 `psm status`，完整机器输出用 `--json`。

```text
.psm/runs/<group>/<six-digit-id>/
  run.json                  # 状态、cwd、配置、进程身份、心跳、idleSince、restartCount
  worker.lock               # 当前 worker 的独占声明；确认旧进程退出后由 restart 更换
  launch.json               # 最近一次启动的 worker PID、身份和 token
  control.lock/owner.json   # 临时控制锁；协调 prompt、stop、restart 和 idle 停止
  agent/                    # 独立配置；models.json 为源文件的符号链接
  session.jsonl             # Pi 原生会话
  session.l1.md             # 完整会话的阅读归档
  session.l3.md             # 完整会话的问答归档
  001.in.md                    # 首轮 prompt
  001.out.md                   # 成功后的最终文本，可能为空
  001.status.json           # 轮次状态与输入 SHA-256
  002.in.md                    # 下一轮 prompt
  logs/
    events.jsonl            # 原始 RPC 响应和事件
    stderr.log              # Pi/worker 诊断
    restarts.jsonl          # 恢复前的 run 状态及队列历史
  stop.json                 # 停止请求，由 psm stop 生成
```

用户只应新增下一编号的 `.in.md`，也可用 `psm prompt` 自动分配并发布。其他文件由 PSM/Pi 管理。开发期已直接切换到 `.in.md/.out.md`；不兼容、不迁移旧 `.in/.out`，没有协议版本分支，请新建 run。

## 输入发布与结果

1. 编号从 `001` 开始，连续到 `999`；遇到缺号等待，非法编号如 `000.in.md`、`1000.in.md` 使 run 失败。
2. 首条 prompt 由 CLI 写入 `001.in.md`。后续建议写 `002.tmp`，写完后原子重命名为 `002.in.md`。
3. worker 定期扫描，不依赖 `fs.watch`，适用于 WSL drvfs；内容摘要保持不变达到 `stableMs` 后消费。空白输入等待补全。
4. 直接编辑 `.in.md` 受稳定窗口保护，但无法保证识别长时间暂停的编辑；需要明确提交边界时使用临时文件 + rename。
5. 一次只有一轮在执行，后续文件排队；不会把新文件作为 steering 注入当前轮。
6. 已消费的编号不会重新执行，修改旧 `.in.md` 不改变已提交输入。状态保存的是发送时文本摘要，session 保存模型实际收到的内容。
7. 成功输出和归档处理完毕后再更新状态为 `completed`；轮次失败/取消/中断不生成 `.out.md`。L1/L3 在每轮结束及退出时刷新，使用稳定文件名。

`.out.md` 的 YAML frontmatter 提供本轮详情位置，之后原样保留最终答复（允许空正文）：

```yaml
---
round: "001"
detail_file: session.l1.md
detail_start_line: 42
detail_end_line: 186
---
```

路径相对输出文件所在目录；行号从 1 开始、首尾包含，可用 `offset=start`、`limit=end-start+1` 读取。范围按本轮实际 session entry 边界生成，包括输入、工具过程和最终答复，不按 prompt 文本猜测。状态文件保存 `entryStart`（含）和 `entryEnd`（不含）的零基 entry 索引，用于归档重生成后刷新所有成功回复的行号。归档失败保留答复，frontmatter 改用 `detail_status: unavailable`，错误见 `run.json.archiveError`。L1 和各输出文件分别原子替换；若读取恰逢下一轮归档刷新，应在该轮结束后重读定位信息。

输入 `.in.md` 必须是普通文件，不接受符号链接。协议以文本 prompt 为主，不把 `@file` 自动展开为附件；Pi RPC 本身也不接受 CLI `@file` 参数。

## 测试

```bash
npm test
# 可选：真实 Pi + 本地模拟模型 API，无外部凭据或费用
PSM_REAL_PI=/absolute/path/to/pi node --test test/psm-real-pi.test.ts test/psm-pipeline-real.test.ts
```

默认回归使用模拟 RPC 子进程，真实 Pi 集成测试未设置变量时跳过。macOS 使用相同 POSIX 实现，但是否完成实机验证见发布说明。

## 相关

- [设计和状态机](../concepts/psm.md)
- [首次使用](../tasks/run-psm.md)
