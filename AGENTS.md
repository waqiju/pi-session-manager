# AGENTS.md

## 项目概述

garden（pi-session-manager）：把 pi 的 session 记录（`.jsonl`，机器格式、人类阅读困难）
转换为四级 markdown 归档（l0 / l1 / l2 / l3），输出到与 sessions 同级的 `garden/` 目录。

## 技术栈

- Node.js ≥ 22.18，零依赖，无构建（原生 type-stripping 直接运行 `.ts`；只允许可擦除语法）
- 测试：`npm test`（node --test，fixture 覆盖全部 entry 类型 + 分支 + compaction）

## 开发规范

- **技术文档**：在 `wiki/internals/` 维护，仿 k8s 范式（concepts / tasks / reference）。
  入口：[wiki/internals/README.md](wiki/internals/README.md)；改代码前先读
  [系统地图](wiki/internals/concepts/system-map.md)
- **文档校验**：修改 wiki、本文件或 README 后运行 `python3 scripts/check_wiki_links.py`
- **渲染行为变更必须 bump** `src/render/shared.ts` 的 `GARDEN_VERSION`
  （增量判断靠 frontmatter 版本标记，不 bump 不会全量重生成）
- **预算常量**集中在 `src/render/truncate.ts`，调整流程见
  [tune-budget](wiki/internals/tasks/tune-budget.md)
- **截断哲学**：宁多不少、头尾 6:4、整行/词边界断点、永不硬切 ——
  [truncation](wiki/internals/concepts/truncation.md)
