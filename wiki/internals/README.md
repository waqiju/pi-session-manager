# Internals Wiki

garden（pi-session-manager）的内部技术文档，仿 Kubernetes 文档范式组织。

## 文档分区

| 分区 | 路径 | 内容 |
|------|------|------|
| Concepts | `concepts/` | 系统地图与核心概念：改代码前先读 |
| Tasks | `tasks/` | 标准工作流，任务页强制五段式：Before You Begin → Steps → Verify → Troubleshooting → Related |
| Reference | `reference/` | 字典式查阅：CLI、API、常量、输出格式 |

## 常用入口

- garden 全景与模块划分：[system-map](concepts/system-map.md)
- l0/l1/l2/l3 四级输出的定位：[lod-levels](concepts/lod-levels.md)
- 截断的设计哲学与预算依据：[truncation](concepts/truncation.md)
- pi session 格式（garden 依赖的部分）：[session-format](concepts/session-format.md)
- 日常转换 / 增量 / 全量重生成：[run-conversion](tasks/run-conversion.md)
- 反向同步（Ctrl+G 把编辑过的 index.md 应用回 sessions）：[reverse-sync](concepts/reverse-sync.md)
- 调整截断预算的标准流程：[tune-budget](tasks/tune-budget.md)
- pi 新增 entry 类型时的跟进：[add-entry-type](tasks/add-entry-type.md)
- 输出 md 的格式字典（frontmatter / 节标题 / marker）：[output-format](reference/output-format.md)
- pi 扩展的触发点与配置：[extension](reference/extension.md)
- 预算常量表：[constants](reference/constants.md)

## 规则

- 修改 wiki 链接或新增任务页后，运行 `python3 scripts/check_wiki_links.py` 校验
  （链接可达性、必备 README、任务页五段式）。
- 链接统一用仓库根路径形式：`wiki/internals/...`。
