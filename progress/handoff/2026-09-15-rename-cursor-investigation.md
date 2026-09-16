# 调查：/garden rename 模式缺少光标（已修复）

- 日期：2026-09-15（调查+修复：同日二轮）
- 状态：**已修复**（v0.4.2）：LineInput 补反显假光标，对齐 pi-tui Input/editor
- 关联：v0.3.2 自绘选择器（extensions/garden-selector.ts）

## 现象

pi 内建 `/resume` → rename（Ctrl+R）有硬件光标（闪烁输入条），
`/garden` → rename 没有。

## 根因（二轮调查结论，2026-09-15）

pi 的"光标"是**两个独立机制**，用户看到的是第一个：

1. **假光标（反显字符）**：pi-tui `Input.render`（input.js:408）与主编辑器
   `editor.js:447` 都把光标处字符渲染成 `\x1b[7m<char>\x1b[27m` 反显块（行尾用反显空格）。
   **与任何设置无关，总是可见** —— 这是用户在 /resume rename 看到的"光标"。
2. **真硬件光标**：CURSOR_MARKER → `extractCursorPosition` → 定位 + `\x1b[?25h/l`。
   但 `settings-manager.js:944`：`getShowHardwareCursor() = settings.showHardwareCursor
   ?? PI_HARDWARE_CURSOR==="1"` —— **默认 false**，即默认配置下真光标始终被
   `\x1b[?25l` 隐藏；marker 的实际用途是 IME 候选窗定位（editor.js 注释原话）。

garden 的 `LineInput.render` **只嵌了机制 2 的 marker，完全没渲染机制 1 的反显块**
（garden-selector.ts:182 对比 input.js:408）。所以默认配置下 rename 输入框看不到
任何光标。list 模式搜索框同理无可见光标（被 "›" 选中指示器掩盖，未被注意）。

### 验证过程（全部 headless 可复现）

1. `temp/probe-rename-cursor.mjs`：rename 模式渲染原始字节**含 marker**（`❯ name\x1b_pi:c\x07`），
   组件层无罪。
2. `temp/probe-rename-tui.mjs`：真实 TuiAltScreen + pi 同款 VStack/ScrollView 布局 +
   假终端，`showHardwareCursor=true` 时 rename 光标**定位正确且显示**（row 36 col 16）——
   TUI 链路无罪。
3. `temp/probe-rename-mainscreen.mjs`：TuiMainScreen（pi 默认 regular 模式）同样正常。
4. 对比渲染源码：input.js / editor.js 有 `\x1b[7m` 反显块，garden LineInput 没有 → 差异点。
5. `showHardwareCursor` 默认 false → marker 链路默认不可见 → 唯一可见光标来源就是反显块。

### 修复方案（已实施，v0.4.2）

给 `LineInput.render` 加假光标（对齐 pi-tui input.js:406-410）：
光标处字符（行尾用空格兜底）包 `\x1b[7m…\x1b[27m`，放在 CURSOR_MARKER 之后；
行尾反显空格 +1 列纳入超宽判断；光标按 code point 取（与 LineInput 编辑粒度一致，
ZWJ 簇只反显首个 code point，可接受）。truncateToWidth 已认 CSI 序列，截断路径无需改。
测试：garden-selector.test.ts 补 LineInput 渲染断言（反显块存在 / 宽字符 / 超宽截断存活）。

---

# 以下为一轮调查存档（当时未定位根因）

## 调查（TUI 光标显示链路）

pi-tui 的硬件光标流程：

1. `showOverlay(component)` → `setFocus(component)`
2. `setFocusInternal` → `isFocusable(component)` 检查 `"focused" in component`
   → 是则 `component.focused = true`
3. 组件 `render(width)` 返回行，行里嵌 `CURSOR_MARKER`（`\x1b_pi:c\x07`）
4. `doRender()` → `extractCursorPosition(lines, height)` 扫描 marker →
   计算行列 → 光标定位 + `showHardwareCursor ? show : hide`

代码位置：`@earendil-works/pi-tui/dist/tui.js`（isFocusable / setFocusInternal），
`dist/tui-alt-screen.js`（doRender / extractCursorPosition）。

## 排除项

| 疑点 | 结论 |
|------|------|
| TUI 没设 focused=true？ | 设了——GardenSelectorComponent 有 `focused` class field，`"focused" in component` → true |
| CURSOR_MARKER 没嵌入渲染行？ | 嵌了——`LineInput.render` 在 focused=true 时插入 marker，TUI 的 `extractCursorPosition` 用 `line.indexOf(CURSOR_MARKER)` 找 |
| marker 被 ANSI 剥离提前删掉？ | 没有——marker 是 APC 序列（`\x1b_pi:c\x07`），不匹配 CSI（`\x1b[...`）也不匹配 OSC（`\x1b]...`），`applyLineResets` / `extractCursorPosition` 之前的处理不会删它 |
| `showHardwareCursor` 为 false？ | 不可能——pi 内建 /resume 的 rename 也有光标，说明该值为 true |
| 重命名模式切换时焦点丢失？ | 不会——`handleInput` 改 mode 后调 `requestRender()`，焦点不涉及 |

## 未排除项

1. **pi 内实测是否真的缺光标**：probe 用 `stripAnsi` 剥掉了 marker，肉眼看不到；
   但真实 pi TUI 的 `doRender` 会处理它。可能问题只存在于视觉判断偏差。
2. **GardenSelectorComponent 不是 Container 子类**：pi 的 `SessionSelectorComponent extends Container`，
   实现 `focused` getter/setter，setter 向下传播给 `searchInput.focused` / `renameInput.focused`。
   我们的组件是纯 class，`focused` 是普通 field（无 setter），LineInput 通过方法参数接收 focused。
   TUI 焦点传播链路是否对 plain class 有特殊处理——未验证。
3. **TUI 的 overlay 渲染是否对 marker 有额外处理**（如去重、行裁剪）——未读完整渲染管线。

## 下一步

1. 在 pi 内实际跑 `/garden` → Ctrl+R → 确认光标是否真的缺失
2. 如确认缺失，在 `probe-selector.mjs` 的 rename 渲染输出中打印**原始字节**（不 stripAnsi），
   检查 `\x1b_pi:c\x07` 是否存在
3. 如 marker 存在但仍无光标，查 `showHardwareCursor` 值（在 `doRender` 加临时 log）
4. 如 marker 不存在，查 `LineInput.render` 的 focused 参数在 rename 模式下的实际值
   （可能是 TUI 未对 plain class 组件调 setFocus 的 edge case）