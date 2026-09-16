# /garden 选择器功能总结

- 日期：2026-09-15
- 项目：garden（pi-session-manager）
- 状态：完成；package 0.3.0 → 0.3.2；GARDEN_VERSION 0.7.3

## 功能目标

快速浏览/搜索/切换历史 session，对标内建 `/resume`。

## 演进路径

### v1 基础选择器（0.3.0）

- 新增 `/garden`：快速 session 选择器
- 新增 `/gardener-open [lN]`：浏览器打开当前 session 的 garden md
- 原 `/garden` 改名为 `/gardener-output`
- 集成 pi 官方 `SessionSelectorComponent`

### v2 全文搜索 + 富化修复（0.3.1）

- **修复 bug**：富化整体失效（可读文件名改造后，jsonl 名与 garden 文件名无推导关系）
- **全文搜索默认启用**：l2 正文回填 `allMessagesText`
- `PI_GARDEN_SELECTOR_FULLTEXT=0` 可退回只搜 id/name/cwd

### v3 自绘选择器（0.3.2）

**起因**：pi 官方组件在 drvfs 上卡 ~22s（`canonicalizePath` 每 session 3 次 × 23ms/次）

**方案**：自绘轻量选择器替代 pi 组件

### v4 自有快捷键 + 子树复制（0.4.0）

- **修复**：Ctrl+N 新建子会话失效——根因双层：pi git package clone 不自动更新（修复未部署）
  + pi 0.85.1 把 ctrl+n 改绑 `app.session.toggleNamedFilter`（`app.session.new` 默认键掏空）
- **`isCtrlLetter` 编码无关匹配**：legacy 控制字符 / Kitty CSI-u / modifyOtherKeys 三编码
  全覆盖，不借 pi 上游 action 名（上游改绑已坑过一次；自定义 action 进不了 pi 的 KeybindingsManager）
- **新增 Ctrl+Y 复制子树**：v0.4.0 初版，v0.4.1 重设计输出格式（面向目标 AI：自解释头部 /
  编号对齐树与路径 / 绝对路径 / 无名节点回退摘要 / 实际最高级别）；>99 硬拒；
  平台命令 pbcopy/clip.exe/wl-copy/xclip

## 当前性能

| 指标 | 内建组件 | 自绘组件 |
|------|---------|---------|
| current scope | ~22s | **0.4-0.5s** |
| all scope | ~27s | **1.4s** |
| 搜索按键 | ~230ms | <50ms |
| 切 scope（已加载） | 重付 22s | <5ms |

## 关键决策

- **md 是唯一数据源**：frontmatter + l2 正文，不再依赖 jsonl
- **零 realpathSync**：fork 树按 basename 配对（uuid 全局唯一）
- **选中时才检查 jsonl 存在**：列表期省 315 次 existsSync（~7s）
- **删除 = 删 jsonl + 清全部 md 产物**（按 session_id 反查）

## 已知取舍

- 未转换的 session 不出现在列表（需先跑 `/gardener-output all`）
- 裁剪：sort 三模式、named-only 过滤、path 显示开关
- rename 后旧 slug 残留靠去重隐藏，物理清理等下次全量

## 遗留事项

- watch daemon 模式
- 嵌套目录递归扫描决策
- 人工 TUI 验证（搜索/Tab/Ctrl+R/Ctrl+D/Enter）

## 测试

- 84 个全过（session-list / session-tree / garden-selector / textwidth）
- `node scripts/probe-selector.mjs` 真实数据 PASS
