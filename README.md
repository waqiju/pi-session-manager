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

## 四级输出

| 级别 | 定位 |
|------|------|
| `xxx.l0.md` | 证据级全量归档 |
| `xxx.l1.md` | 调试与阅读主力（截断后约为 l0 的 1/3） |
| `xxx.l2.md` | 剧情骨架（prompt + assistant text 全量交织 + 工具一行摘要） |
| `xxx.l3.md` | 纯问答对话（l2 基础上每轮只留最终答复） |

每份文件带 YAML frontmatter（session id、cwd、起止时间、模型、token/成本汇总）。

## 文档

- 技术文档（概念 / 工作流 / 字典）：[wiki/internals](wiki/internals/README.md)
- 开发规范（AI 助手入口）：[AGENTS.md](AGENTS.md)

## 开发

```bash
npm test                          # node --test
python3 scripts/check_wiki_links.py   # 改了 wiki / README / AGENTS 后运行
```
