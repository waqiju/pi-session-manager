# Handoff: garden selector Ctrl+N（新建子会话）失效

- 日期：2026-09-15
- 项目：garden（pi-session-manager）
- 状态：**未解决**，初始修复（`data === "\x0e"` 替换 `kb.matches`）无效
- 相关提交：`a3e7317`（已推送，需继续调查）

## 1. 问题

在 `/garden` 选择器列表里按 Ctrl+N，"新建子会话" 功能不生效。
底部 hint 显示 "Ctrl+N 新建子会话" 但按键无反应。

## 2. 已尝试

### 尝试 1：pi keybinding 变动导致 `kb.matches` 失效 ❌ 不是根因

调查发现 pi 上游把 Ctrl+N 从 `app.session.new` 改绑到 `app.session.toggleNamedFilter`：

```
pi keybindings.d.ts:
  app.session.toggleNamedFilter → defaultKeys: "ctrl+n"
  app.session.new                → defaultKeys: []  ← 空
```

以为 `kb.matches(data, "app.session.new")` 永远 false 是原因，改为直接匹配原始字节 `\x0e`：

```ts
// 旧：} else if (this.opts.onNewChild && kb.matches(data, "app.session.new")) {
// 新：} else if (this.opts.onNewChild && data === "\x0e") {
```

**提交 `a3e7317`**，测试全过（mock 里 KEY_MAP 把 `\x0e` 映射到 `"app.session.new"`）。
但用户反馈问题依然存在。

### 尝试 2：pi 吞掉了 Ctrl+N？

可能的解释：pi 的内建 keybinding 系统在 `handleInput` 被调用之前就把 Ctrl+N 拦截处理了
（`app.session.toggleNamedFilter`），`data` 根本到不了 garden-selector 的 `handleInput`。

**未验证**——需要继续调查。

## 3. 关键文件和代码位置

| 文件 | 行为 |
|------|------|
| `extensions/garden-selector.ts:handleInput()` (line ~408) | 按键分发入口，`data === "\x0e"` 匹配 Ctrl+N |
| `extensions/garden.ts:255` | `onNewChild` 回调定义：`ctx.newSession({ parentSession: item.path })` |
| `extensions/garden.ts:279` | `ctx.ui.custom()` 注册 GardenSelectorComponent |
| pi-tui KeybindingsManager | `matches(data, action)` —— 可能是拦截点 |

## 4. 继续调查方向

1. **验证 Ctrl+N 是否到达 handleInput**：在 `handleInput` 开头加 `console.error("data:", JSON.stringify(data), "hex:", Buffer.from(data).toString("hex"))` 临时调试，看 `\x0e` 是否真的传进来了

2. **检查 pi 的 keybinding 拦截机制**：pi-tui 的 `KeybindingsManager.matches` 是否在组件的 `handleInput` 之前被调用？
   - 如果 pi 先匹配到 `app.session.toggleNamedFilter`，可能直接消费掉事件不往下传
   - 读 pi-tui 源码：`node_modules/@earendil-works/pi-tui/dist/` 或 `node_modules/@earendil-works/pi-coding-agent/dist/`
   - 搜 `toggleNamedFilter` 的调用点，看它在哪一层被处理

3. **`ctx.ui.custom()` 的按键事件链**：custom 组件的 `handleInput` 是怎么被调用的？
   - 可能有中间层做了 keybinding 匹配/拦截
   - 搜 pi-coding-agent 的 `custom` 实现（`dist/core/` 或 `dist/tui/`）

4. **对比内建 SessionSelectorComponent**：内建组件怎么处理 Ctrl+N？
   - 如果内建组件用的是 pi 的 action 系统而不是 raw data，可能有不同的事件路径

## 5. 复现环境

- pi 版本：见 `node_modules/@earendil-works/pi-coding-agent/package.json`
- OS：WSL2 (drvfs)
- 触发：在 pi 里运行 `/garden`，列表里按 Ctrl+N
- hint 底部显示 "Ctrl+N 新建子会话" 但按键无反应
