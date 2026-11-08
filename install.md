# 安装 PSM（供人类与 Agent 使用）

可以将本文件链接直接交给 Agent：https://github.com/waqiju/pi-session-manager/blob/master/install.md

目标：从 `master` 安装 PSM，使任意工作目录都能调用 `psm` 和 `garden`。默认安装目录为 `~/.local/share/pi-session-manager`；用户已有克隆时优先复用。命令适用于 Linux、WSL、macOS；原生 Windows 请使用 WSL。

## 1. 检查环境

```bash
node --version
npm --version
git --version
pi --version
command -v psm
command -v garden
```

需要 Node.js >= 22.19、Pi >= 1.5。缺少 Pi 时，可用当前用户的 Node/npm 环境安装：

```bash
npm install -g @earendil-works/pi-coding-agent
```

先核对已有命令指向，避免覆盖其他项目的同名命令。使用 nvm 等用户级 Node 环境时无需 sudo；全局命令注册到该 Node 环境，切换 Node 版本后可能需要重新 link。

## 2. 获取源码并注册全局命令

首次安装：

```bash
mkdir -p "$HOME/.local/share"
git clone --branch master https://github.com/waqiju/pi-session-manager.git "$HOME/.local/share/pi-session-manager"
cd "$HOME/.local/share/pi-session-manager"
npm ci --ignore-scripts --legacy-peer-deps
npm link --ignore-scripts --legacy-peer-deps
```

已有克隆时，检查 `git remote -v`、`git status --short --branch`，确认仓库正确；保留用户未提交修改，不直接覆盖或重置。干净的 master 可用 `git pull --ff-only origin master` 更新。用户要求固定版本时，checkout 指定 tag/commit 后再执行上述依赖安装和 link。

本项目直接运行 TypeScript，无构建步骤。`--legacy-peer-deps` 避免额外安装 Pi peer；PSM 使用 PATH 中已安装的 Pi，或配置 `piCommand`。`npm link` 注册源码链接，因此安装目录必须保留。这里安装的是 CLI；需要交互式 Pi 的 garden 扩展时，另见 [README](README.md)。

## 3. 配置后台默认模型

默认全局配置目录为 `~/.psm`；设置 `PSM_HOME` 时使用该目录。项目当前目录的 `.psm/config.json` 覆盖全局字段。

首次配置可创建 `config.json`：

```json
{
  "defaultModel": "deepseek/deepseek-chat"
}
```

这是示例，使用用户选择且已配置认证的模型。已有配置只修改必要字段，不覆盖其他设置。旧 `config.json.models` 是已移除的别名表：把别名对应的 `provider/model[:thinking]` 写进默认值和命令，再删除别名表。`models.json` 是 Pi provider 定义文件，需要保留。

模型表达式交给 Pi 解析，可以是精确 ID、模糊名称、`provider/model`，也可以带 `:high` 等 thinking 后缀。PSM 的默认值独立于 Pi TUI；没有默认值时仍可显式运行 `psm <model-expression> "prompt"`。

认证使用 PSM 自己的 `models.json` / `auth.json` 或 provider 环境变量；不会自动读取全局 Pi 的认证。复用用户指定的配置来源，不把凭据输出到对话或写入仓库。provider 配置格式、文件选择规则及完整参数见 [PSM 配置参考](wiki/internals/reference/psm.md)。

## 4. 验证安装

从安装目录之外执行：

```bash
cd "$HOME"
command -v psm
command -v garden
psm --help
garden --help
```

这组检查不启动模型任务。检查命令路径对应预期安装目录，报告安装 commit（`git -C "$HOME/.local/share/pi-session-manager" rev-parse HEAD`）与 Pi/Node 版本。若使用其他安装目录，相应替换路径。

用户需要验证模型时，在目标项目目录执行：

```bash
psm "简短回复安装验证成功，不调用工具。"
psm list
psm status <返回的ID>
psm logs <返回的ID> --no-follow
psm stop <返回的ID>
```

模型验证会调用配置的 API。启动成功只代表后台就绪；检查轮次状态为 completed 才代表请求成功。首次使用流程见 [run-psm](wiki/internals/tasks/run-psm.md)。

## 5. 升级与卸载

升级前检查源码工作区，已有修改需先保留。默认跟踪 master：

```bash
cd "$HOME/.local/share/pi-session-manager"
git status --short --branch
git switch master
git pull --ff-only origin master
npm ci --ignore-scripts --legacy-peer-deps
npm link --ignore-scripts --legacy-peer-deps
psm --help
```

对需要升级的活跃 run，先在更新源码前执行 `psm stop <id>`，更新后执行 `psm restart <id>`。worker 不会热更新；restart 保留会话与已解析模型，不重放中断轮次。固定版本安装应更新到用户指定的新 tag/commit。

卸载前停止需要关闭的 run，再移除命令链接：

```bash
npm uninstall -g pi-session-manager --ignore-scripts --legacy-peer-deps
```

确认不再使用后可移除安装源码目录。默认保留 `~/.psm` 以及各项目 `.psm` 的配置、凭据、历史会话；删除这些数据应由用户另行决定。
