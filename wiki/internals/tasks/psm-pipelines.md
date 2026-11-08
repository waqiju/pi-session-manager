# 使用 JS pipeline 启动 PSM

`psm run <pipeline> <prompt>` 用 JS 组织模型、Pi 资源和 PSM 参数，然后创建普通后台 run。无需 build。后续继续使用 `psm <id> "prompt"`、`logs`、`stop`、`restart`。

## Before You Begin

准备 Node.js >= 22.19、Pi >= 1.5，以及可用的 PSM 模型认证。使用已有安装中的 Pi，资源包需提前安装好。

## Steps

### 安装并运行 web-search 示例

在仓库根目录执行，目标 `.psm/web-search` 应不存在：

```bash
mkdir -p .psm
cp -R examples/pipelines/web-search .psm/web-search
psm run web-search "最近十天，日本有哪些重要新闻？请引用来源。"
psm run web-search --file ./question.md
```

也可把示例目录复制到 `~/.psm/web-search`，让各工作目录使用。设置 `PSM_HOME` 时，使用该目录代替 `~/.psm`。本地 `.psm/<name>` 优先于全局；本地目录存在但入口缺失、语法错误或配置无效时直接失败，不回退。

示例固定模型 `deepseek/deepseek-v4-flash`，使用 `isolated`，只开放 `read`、`web_search`、`web_fetch`。不必改日常 Pi 环境。若该模型在你的 provider 中不可用，在 `pipeline.mjs` 改成可用的完整表达式；搜索工具也可供其他 provider 的模型调用。

认证优先读取运行时 `DEEPSEEK_API_KEY`，否则通过 Pi 的 `getProviderAuth("deepseek")` 解析 PSM 的 DeepSeek 配置。模型认证仍来自 PSM 的 `auth.json`、`models.json` 或 provider 环境变量。不要把密钥放进 pipeline、prompt 或 CLI 参数。

搜索直接调用 DeepSeek 官方 `POST /v1/tools/search`；正文调用 `POST /v1/tools/fetch`。参见 [官方文档](https://api-docs.deepseek.com/guides/search)。2026-11-09 文档价格：两者均为每 1000 次成功且有结果的请求 0.75 美元，另有模型调用费用。服务价格与账号权限以官方为准。

每次工具调用总期限 30 秒；408、429、5xx 和连接错误最多重试两次。取消会中止请求与重试等待。401、402 等不会自动重试；错误不回显响应正文或密钥。拒绝重定向，响应最多 8 MiB；模型收到的结果限制 2000 行 / 50 KiB，超出部分写入私有临时文件，工具结果给出路径。工具的网页内容是外部资料，不作为执行指令。

### 定义 pipeline

```text
.psm/review/
  pipeline.mjs
  tools/review.ts
  skills/review/SKILL.md
```

```js
export default async function ({ cwd, pipelineDir }) {
  return {
    resources: "inherit",
    agentDir: "~/.pi/agent",
    model: "deepseek/deepseek-v4-flash",
    thinking: "high",
    group: "review",
    extensions: [`${pipelineDir}/tools/review.ts`],
    skills: [`${pipelineDir}/skills/review`],
    disable: ["mcp"],
    tools: ["+grep", "-write"],
    excludeTools: ["edit"],
    appendSystemPrompt: `检查 ${cwd} 的代码，先给出调查结论。`,
    config: { turnTimeoutMs: 1800000, idleTimeoutMs: 3600000 },
  };
}
```

函数可以同步或异步，必须返回对象。PSM 使用 Node 原生 ESM 加载 `.mjs`；执行 pipeline 即执行本地 JS。相对资源路径和显式 `agentDir` 相对 `pipeline.mjs` 所在目录解析；`cwd` 始终是调用 PSM 的工作目录。目录名使用 1～64 位字母、数字、`_`、`-`，首位必须是字母或数字；`runs`、`registry`、`ids` 为保留名。

| 字段 | 行为 |
|---|---|
| `resources` | `inherit`（默认）或 `isolated` |
| `agentDir` | 仅 inherit：显式路径 → `PI_CODING_AGENT_DIR` → `~/.pi/agent` |
| `model` | Pi 模型表达式；省略时使用 PSM defaultModel |
| `thinking` | 显式 thinking；Pi 会按模型能力钳制，实际结果固定到 run |
| `group` | 默认 default；CLI `--group` 优先 |
| `extensions` | 追加本地扩展文件/目录，也接受 `builtin:mcp`、`builtin:codemode`、`builtin:tool-search`、`builtin:llama.cpp` |
| `skills` | 追加本地 skill 文件/目录 |
| `promptTemplates` | 追加本地 prompt template 文件/目录 |
| `disable` | 关闭自动加载的资源类别：extensions、skills、promptTemplates、themes、mcp、contextFiles；显式 extensions/skills/template 仍加载 |
| `tools` | 完整工具列表，或全部使用 `+name` / `-name` 增减默认列表；两种写法不能混用。`[]` 关闭所有工具 |
| `excludeTools` | 工具名称/模式的排除列表，沿用 Pi `--exclude-tools` 语义 |
| `appendSystemPrompt` | 附加系统提示，沿用 Pi 文本/文件路径语义 |
| `config` | 覆盖 PSM 的 pollMs、stableMs、startupTimeoutMs、turnTimeoutMs、idleTimeoutMs |
| `piArgs` | 额外开关仅允许 `--verbose`、`--no-builtin-tools`；其他能力使用结构化字段 |

添加某一资源、关闭某一类别后只加载选择的资源，均可通过上述组合实现。例如 `disable: ["extensions"]` 加 `extensions: ["./tools/review.ts"]` 只保留指定扩展。关闭 extensions 也关闭内置扩展；需要 MCP 时显式追加 `builtin:mcp`，间接工具还需 `builtin:codemode` 或 `builtin:tool-search`。

PSM 保留 RPC mode、session 路径、cwd、模型选择等字段的所有权，不允许 `piArgs` 更换 session 或注入首条 prompt。JS 配置中未知字段和无效值会报错。

### inherit 与 isolated

| 行为 | inherit | isolated |
|---|---|---|
| 全局指令、SYSTEM/APPEND_SYSTEM | 来自指定 agentDir | 不自动加载 |
| cwd/父目录 AGENTS 等上下文 | 加载；可用 disable 关闭 contextFiles | 不自动加载 |
| 全局 extensions、skills、templates、themes | 继承配置和发现目录 | 不自动加载 |
| 当前项目 `.pi` 资源 | 本次启动使用 `--approve` 加载 | 使用 `--no-approve` 跳过 |
| MCP | 继承配置及私有 OAuth 凭据副本 | 默认禁用；可通过显式 builtin:mcp 和注册服务器的扩展启用 |
| 模型/auth 配置 | 使用 PSM 配置 | 使用 PSM 配置 |
| 默认内置工具 | 继承 Pi defaultTools，可由 pipeline 覆盖 | Pi 默认工具，可由 pipeline 覆盖 |

`inherit` 的项目加载决定仅作用于当前 Pi 进程，不修改原项目的 trust 配置。选择继承模式意味着允许本次运行加载该项目的资源。两种模式均保留独立 `agent/`、session 和日志；`isolated` 指资源加载方式，不是操作系统沙箱。

inherit 把 settings、指令和 MCP 配置复制到私有 agent 目录，重定位相对资源路径；本地资源、已经安装的 git/npm package 缓存保持引用，保留依赖目录。不会复制源 Pi 的模型 `auth.json` 或 `models.json`。MCP OAuth 凭据复制后由本 run 独立维护，不回写源目录。HTTP 代理等 Pi settings 可被继承；自定义扩展如果自行硬编码读取其他路径，其行为由扩展自身决定。

两种模式均使用 `--offline` 禁止 Pi 自动刷新模型目录等活动，它不禁止模型 API、搜索接口或工具联网。扩展需要终端 UI 时必须自行适配 RPC；如果请求 select/confirm/input/editor，PSM 会返回取消并让 run 明确失败。RPC 上不支持的自定义 TUI 组件仍受 Pi 自身限制。

### 恢复与变更检查

首次启动执行 JS 一次，将解析结果、资源来源和内容摘要写入 `run.json.pipeline`。restart 复用这份结果和实际模型，不重新执行 pipeline 函数。源 pipeline、显式资源、继承配置、指令等发生变化时拒绝恢复，提示恢复文件或创建新 run；原 run 的检查点和 restartCount 不受拒绝影响。

摘要检查包含目录成员和符号链接目标；跳过 `.git`、嵌套 `node_modules` 和 `.psm` 运行存储。它用于检测配置/资源漂移，不是完整的依赖锁：JS 在目录外动态导入的模块、glob 范围外的资源、扩展运行时发现的文件、环境变量和 Pi 安装版本不保证固定；更新这些内容后建议新建 run。模型配置仍遵守原 PSM 的 models.json 符号链接规则。

## Verify

```bash
npm test
PSM_REAL_PI=/absolute/path/to/pi node --test test/psm-real-pi.test.ts test/psm-pipeline-real.test.ts
python3 scripts/check_wiki_links.py
```

真实 Pi 测试使用本地模型 API 和模拟 DeepSeek Search/Fetch，覆盖实际工具声明、工具调用、结果进入下一轮模型上下文，以及 inherit 的指令、skill、package、项目扩展和 MCP 加载；不需要外部凭据或计费请求。

## Troubleshooting

- `Pipeline not found`：确认从预期 cwd 启动，且文件位于 `.psm/<name>/pipeline.mjs` 或全局 PSM 目录；不会向父目录查找。
- `Pipeline resource changed`：恢复提示中的源文件，或者创建新 run 使用新配置。restart 不会重新运行 JS。
- 搜索认证/余额失败：检查 PSM DeepSeek 认证或 DEEPSEEK_API_KEY；不要把密钥复制到 prompt。模型可调用不代表搜索账号权限和余额一定可用。
- `no interactive UI`：所选扩展需要人工对话，改用支持 RPC 无交互执行的配置，或在 pipeline 中关闭该类扩展后新建 run。
- 无联网工具：检查模式、extensions 和 tools；内置 `tool_search` 用于发现工具，并不是网页搜索。`--offline` 不阻止搜索 API 请求。
- 网络请求失败：结合具体错误检查 DNS、IPv4/IPv6、代理和目标服务；仅凭 curl 状态 `000` 不能断定出口白名单。

## Related

- [PSM 配置与协议](../reference/psm.md)
- [PSM 架构](../concepts/psm.md)
