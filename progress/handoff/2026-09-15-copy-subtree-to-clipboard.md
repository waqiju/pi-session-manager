# Handoff: garden 选择器子树复制到剪贴板 —— 已完成

- 日期：2026-09-15
- 项目：garden（pi-session-manager）
- 状态：**已完成**（v0.4.0 落地，v0.4.1 重设计输出格式）
- 快捷键：**Ctrl+Y**（硬编码物理键。自定义 action 路线不可行：pi 0.85.1 的 KeybindingsManager
  丢弃未定义的 action，用户 keybindings.json 无法补绑；Ctrl+C 是 cancel、Ctrl+Shift+C 被
  Windows Terminal 拦截且 legacy 下与 Ctrl+C 同为 \x03、Alt+C 有 Esc 合并歧义）
- 落地差异：① `onCopy` 改为 `copyToClipboard(text) => {ok,error?}`（组件需成败结果 toast）；
  ② 树行格式按 §2 示例执行（name + msgs），size 只在路径清单行；③ 树前缀跳过子树根槽位，
  子节点顶格（屏幕渲染的 3 空格前导不进导出文本）
- v0.4.1 格式重设计（面向目标 AI 可读性）：自解释头部（fork 语义/级别规则/总量/cwd）+
  编号树内联元数据（`[n] 名称 — msgs · size · 日期`）+ 同编号绝对路径清单（弃用 `~`，
  部分读文件工具不展开）；无名节点回退首条消息摘要；路径取实际存在最高级别 md

---

## 原始需求存档

## 1. 需求概述（原始）

在 `/garden` 选择器列表里，按快捷键把当前光标所在 session 的**整棵子树**复制到剪贴板。
输出的是树结构 + 文件路径（不是拼接内容），供用户粘贴到另一个 AI 对话作为 context，
目标 AI 可按需用工具读取具体文件。

## 2. 详细规格

### 复制范围

- 从光标所在 session 开始，递归包含所有后代（children）
- 光标在 root → 复制整棵树
- 光标在叶子（无 children）→ 复制单个 session
- 上限 **99 个 session**，超出时 toast 提示"子树过大（N>99），请缩小范围"，不执行复制

### 输出内容（复制到剪贴板的文本）

```markdown
## Garden Session Subtree

根: {name} ({messageCount} msgs)
├── {child1_name} ({child1_messageCount} msgs)
│   └── ...
└── {child2_name} ({child2_messageCount} msgs)

文件路径（l3 = 纯问答视图；同名 .l1.md 含工具细节和完整推理）:
  {l3_file_path_1}  {size_1}  {line_1}
  {l3_file_path_2}  {size_2}  {line_2}
  ...
```

### 树节点显示

每个节点显示三项：
- **name**：session 名（`SessionListItem.name`，无名则 "untitled"）
- **size**：l3.md 文件大小（复制时 stat，格式 `14KB` / `1.2MB`）
- **line**：消息条数（`SessionListItem.messageCount`，显示如 `42 msgs`）

### 文件路径格式

- 用 `~` 缩短 home 目录（`os.homedir()`）
- 路径后附 size 和 line（与节点显示一致），方便目标 AI 不读文件就能判断相关性
- 示例：`~/.pi/agent/garden/--D--xxx--/2026-09-14-002-项目重构.l3.md  8KB  35 msgs`

### l1 提示

路径列表前一行文字：
```
文件路径（l3 = 纯问答视图；同名 .l1.md 含工具细节和完整推理）:
```
只列 l3 路径，不列 l1。

### 反馈

复制成功后 toast：`已复制 N 个 session 到剪贴板`
复制失败（剪贴板命令不存在等）toast error。

## 3. 剪贴板平台适配

在 `extensions/garden.ts` 或 `extensions/garden-selector.ts` 中实现，
用 `spawnSync` 调平台命令：

| 平台 | 命令 | 检测方式 |
|------|------|---------|
| macOS | `pbcopy` | `process.platform === "darwin"` |
| WSL | `clip.exe` | `process.platform === "linux" && process.env.WSL_DISTRO_NAME` |
| Linux (X11) | `xclip -selection clipboard` | `process.platform === "linux"` 且无 WSL env |
| Linux (Wayland) | `wl-copy` | 同上，优先检测 `WAYLAND_DISPLAY` |

伪代码：

```ts
function copyToClipboard(text: string): { ok: boolean; error?: string } {
  const cmds: [string, string[]][] = [];
  if (process.platform === "darwin") {
    cmds.push(["pbcopy", []]);
  } else if (process.env.WSL_DISTRO_NAME) {
    cmds.push(["clip.exe", []]);
  } else {
    if (process.env.WAYLAND_DISPLAY) cmds.push(["wl-copy", []]);
    cmds.push(["xclip", ["-selection", "clipboard"]]);
  }
  for (const [cmd, args] of cmds) {
    try {
      const r = spawnSync(cmd, args, { input: text, timeout: 3000 });
      if (r.status === 0) return { ok: true };
    } catch { /* try next */ }
  }
  return { ok: false, error: "无可用剪贴板命令（尝试 pbcopy/clip.exe/xclip/wl-copy）" };
}
```

## 4. 快捷键（待定）

**不能用 Ctrl+C**——TUI 里是 cancel/中断信号。

候选（需确认不与 pi 冲突）：
- `Ctrl+Shift+C`——常见"复制"快捷键，但终端可能拦截
- `Ctrl+Y`——vim 里是 paste，但很多工具用作"yank/copy"
- `Ctrl+G`——"gather"
- 自定义 action name（如 `app.session.copySubtree`），默认不绑键，
  用户可在 pi keybinding 配置里自定义

**建议**：先用 `app.session.copySubtree` action（默认空键），
在底部 hint 里显示"Copy Tree: (配置快捷键)"。后续如果用户确定键再加 defaultKeys。

## 5. 实现切入点

### 关键文件

| 文件 | 作用 |
|------|------|
| `extensions/garden-selector.ts` | 自绘选择器组件，`handleInput` 按键分发、底部 hint 渲染 |
| `extensions/garden.ts` | pi 扩展入口，定义 `onNewChild` / `renameSession` 等回调 |
| `src/session-tree.ts` | 树结构：`buildSessionTree` → `TreeNode`（`session` + `children[]`） |
| `src/session-list.ts` | `SessionListItem` 数据形状（`name`、`messageCount`、`mdDir`、`mdBase`） |

### 数据流

选择器内部已有完整树数据：

```
garden.ts loadCurrent/loadAll → SessionListItem[]
    ↓
GardenSelectorComponent 内部:
    buildSessionTree(items) → TreeNode[]  (roots)
    flattenSessionTree(roots) → FlatNode[]  (渲染用)
    this.flat[selectedIndex] → 当前 FlatNode
    FlatNode.session → SessionListItem (含 mdDir, mdBase, name, messageCount)
```

复制时需要递归 `TreeNode.children`，但选择器当前只存 `flat[]`（展平列表），
没有保留原始 `TreeNode[]`。**需要在组件内缓存 roots 引用**，或从 flat 反查子树。

### 实现方案

1. **GardenSelectorComponent 内部**新增字段 `roots: TreeNode[]`（`buildSessionTree` 的结果），
   在 `refilter()` 时同步更新

2. **新增方法 `collectSubtree(node: TreeNode): SessionListItem[]`**：
   递归收集 node.session + 所有后代 session

3. **新增方法 `buildCopyText(items: SessionListItem[]): string`**：
   - 构建树形文本（用 `buildSessionTree` 对这 N 个 items 建子树）
   - stat 每个 l3.md 获取 size
   - 拼接路径列表

4. **handleInput 里新增分支**：匹配快捷键 → collectSubtree → 检查 ≤99 → buildCopyText → copyToClipboard → toast

5. **SelectorOptions 新增可选字段** `onCopy?: (text: string) => void`，
   让 garden.ts 注入剪贴板逻辑（保持组件零依赖）

### 测试

- `test/garden-selector.test.ts` 已有完整的 harness 和 mock
- 新增用例：子树收集（3 层嵌套）、99 上限拒绝、单 session 无子、输出格式验证

## 6. 不做的事

- 不拼接 md 内容到剪贴板（太大）
- 不包含 l1 路径（只提示"同名 .l1.md"）
- 不截断子树（上限 99 是硬拒，不是截断）
- 不加日期到节点（路径里已有）
- 不读文件正文（只 stat 取 size）
