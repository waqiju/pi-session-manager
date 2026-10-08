# pi-session-manager

简称：garden

把 pi 的 session 记录（`~/.pi/agent/sessions/**/*.jsonl`，人类阅读困难）转换为
四级 markdown 归档，输出到与 sessions 同级的 `garden/` 目录。

## 快速开始

```bash
# 要求：Node.js >= 22.18（原生 type-stripping，无构建）
npm install --ignore-scripts --legacy-peer-deps # 安装网页预览依赖；不另装 pi peer
node src/cli.ts                    # ~/.pi/agent/sessions → ~/.pi/agent/garden
node src/cli.ts <sessions目录>     # 输出到其同级 garden/
node src/cli.ts <xxx.jsonl>        # 单文件模式
```

`npm link` 之后可直接用 `garden` 命令。增量转换：源文件更新或渲染逻辑版本变化时
才重新生成。

## pi 扩展（自动转换）

本仓库同时是 pi package（`extensions/garden.ts`），装入 pi 后在会话生命周期内自动转换
当前 session：启动补漏 → agent 空闲防抖 live 转换 → compaction / 退出时终态落盘。

```bash
pi install /path/to/pi-session-manager      # 本地路径（开发期，/reload 即生效）
pi install https://github.com/waqiju/pi-session-manager   # git package
```

扩展内命令：`/garden`（快速 session 选择器，等位 /resume：fork 树/搜索/改名/删除；
自绘组件零 realpathSync + 数据源只读 garden md 产物，drvfs 上秒开——内建组件因
canonicalizePath 会卡 ~22s；`PI_GARDEN_SELECTOR=builtin` 可回退官方组件）、
`/gardener-output`（转换当前 session，`all` 全量回填，`index` 重建目录索引）、
`/gardener-open [lN]`（浏览器打开 md；`index` 重建并打开目录索引）。
触发点与 `PI_GARDEN*` 环境变量配置见 [extension 参考](wiki/internals/reference/extension.md)。

## SSH 网页预览

从 Windows / WSL SSH 到 Mac 运行 pi 时，连接时添加转发：

```bash
ssh -L 127.0.0.1:13322:127.0.0.1:13322 mac-host
```

远程执行 `/gardener-open [lN]` 或 `/gardener-open index`，检测到
`SSH_CONNECTION` / `SSH_CLIENT` 后不启动远程浏览器，而是在 pi 提示中输出
`http://localhost:13322/...`。手动点击/复制到客户端 Chrome 即可，无需同步 md。
Windows 浏览器访问 WSL 的 localhost 转发需 WSL 网络配置支持。

预览服务首次打开时按需启动，运行在 pi 进程内，仅监听 `127.0.0.1`，只读 garden
Markdown，无访问令牌（仅用于可信本机 / SSH 转发环境，任何能访问该端口的人都可读取已注册 garden 根目录的 md）；索引相对链接可直接跳转。页面无外部资源、无脚本，刷新读取
最新文件。多个 pi 共用同一端口：首个 open 的 pi 托管服务，其他进程验证协议后复用；
借用者退出不影响服务。宿主退出 / `/reload` 后服务暂停，任意 pi 再次 open 会启动新服务；
文档根目录 URL 使用真实路径的稳定摘要，不再使用进程内 r0 编号，重新打开后可恢复原链接
（其他根目录需各自再次 open 注册）。不产生独立后台进程。
没有客户端助手或独立守护程序；URL 是否可点击取决于终端。

- `PI_GARDEN_OPEN_MODE=auto|web|local`：默认 auto；tmux 检测不准时用 web/local 覆盖。
- `PI_GARDEN_PREVIEW_PORT=13322`：同版 garden 自动共用；被其他程序或旧版占用时明确报错；改端口后同时调整 SSH `-L`。
- 非 SSH 默认仍走本地打开器；`PI_GARDEN_OPEN_CMD` 只作用于 local 模式。

详细配置见 [extension 参考](wiki/internals/reference/extension.md)。

**SSH 下 Ctrl+Y 复制**：使用 Pi 公开剪贴板 API，通过 OSC 52 请求客户端终端写入本地
剪贴板，无需端口转发或助手。终端必须支持并允许 OSC 52；tmux 需允许该序列传递。
远程提示只表示请求已发送，无法确认客户端实际写入。Base64 超过 100,000 字符时明确拒绝，
请缩小子树；复制清单中的路径仍是远程路径，不代表文件已传到客户端。

## 目录索引（index.md）

每个 garden 项目目录维护一份 `index.md`：fork 森林（多棵会话树，按最近活跃降序）
+ 嵌套列表（缩进 = fork 层级，🗂️ 有子会话 / 📄 单条），元数据（msgs/日期）包反引号
灰底块，当年日期省略年份，过长名称/摘要按列宽截断；相对路径链接可直接点击，
给 AI 看的说明藏在 HTML 注释里（渲染不占视觉空间）。
重建时机：CLI 转换/`--sync` 收尾（有变化或缺索引的目录）、`garden --index`、
`/gardener-output index`、`/gardener-open index`（打开前总是重建，保证看到最新）。

index.md 同时是**反向同步**的编辑入口：人工调整缩进（换父）或在行尾加 `to-delete` /
`to-archive` 标记后，在 `/garden` 选择器按 `Ctrl+G` 应用回 sessions（先一一对账，
确认条汇总后执行；归档挪入 `1_archived/` 并保留树路径身份）。语义与安全前提见
[reverse-sync](wiki/internals/concepts/reverse-sync.md)。

## 四级输出

| 级别 | 定位 |
|------|------|
| `xxx.l0.md` | 证据级全量归档 |
| `xxx.l1.md` | 调试与阅读主力（截断后约为 l0 的 1/3） |
| `xxx.l2.md` | 剧情骨架（prompt + assistant text 全量交织 + 工具一行摘要） |
| `xxx.l3.md` | 纯问答对话（l2 基础上每轮只留最终答复） |

默认只导出 l1 + l3（l0 与源 jsonl 冗余、l2 语料与 l3 重叠）；用 `PI_GARDEN_LEVELS=l0,l1,l2,l3`
或 CLI `--levels` 调整。每份文件带 YAML frontmatter（session id、cwd、起止时间、模型、token/成本汇总）。

## 文档

- 技术文档（概念 / 工作流 / 字典）：[wiki/internals](wiki/internals/README.md)
- 开发规范（AI 助手入口）：[AGENTS.md](AGENTS.md)

## 开发

```bash
npm test                          # node --test
python3 scripts/check_wiki_links.py   # 改了 wiki / README / AGENTS 后运行
```
