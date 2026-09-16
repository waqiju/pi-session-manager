# pi-session-manager

简称：garden

把 pi 的 session 记录（`~/.pi/agent/sessions/**/*.jsonl`，人类阅读困难）转换为
四级 markdown 归档，输出到与 sessions 同级的 `garden/` 目录。

## 快速开始

```bash
# 要求：Node.js >= 22.18（原生 type-stripping，零依赖、无构建）
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

## 目录索引（index.md）

每个 garden 项目目录维护一份 `index.md`：fork 森林（多棵会话树，按最近活跃降序）
+ 嵌套列表（缩进 = fork 层级），每行内联名称/消息数/大小/日期，相对路径链接可直接点击。
重建时机：CLI 转换/`--sync` 收尾（有变化或缺索引的目录）、`garden --index`、
`/gardener-output index`、`/gardener-open index`（打开前总是重建，保证看到最新）。

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
