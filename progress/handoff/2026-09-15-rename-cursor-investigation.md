# 调查：/garden rename 模式缺少光标（待解决）

- 日期：2026-09-15
- 状态：未解决（根因未定，待 pi 内实测确认）
- 关联：v0.3.2 自绘选择器（extensions/garden-selector.ts）

## 现象

pi 内建 `/resume` → rename（Ctrl+R）有硬件光标（闪烁输入条），
`/garden` → rename 没有。

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