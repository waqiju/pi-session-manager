# Handoff: /garden 自绘选择器 + md 数据源（0.3.2）

- 日期：2026-09-15
- 项目：garden（pi-session-manager）
- 分支：`main`（直接提交，不用 worktree）
- 状态：完成；package 0.3.1 → 0.3.2；`GARDEN_VERSION` 0.7.2 → 0.7.3；84 测试全过

## 起因

`/garden`（以及内建 `/resume`）在 drvfs 上卡 ~22s。另一 agent 诊断为 pi
`SessionSelectorComponent.buildSessionTree` 的 `canonicalizePath`（= realpathSync）
每 session 3 次 × 315 session × 23ms/次（`~/.pi/agent/sessions` 是 drvfs symlink）。
本仓复核全部属实，并发现**比诊断更糟**：搜索清空 / 切 scope / 增删后全量重付，
每次按键渲染还有 `isCurrentSessionPath` 的 ~230ms。

同时人类下达方向调整：`/garden` 只读 garden md 产物，不再依赖 jsonl
（假设转换常驻、md 一定最新）。

## 方案（人类已确认）

自绘轻量选择器替代 pi 组件（fork 866 行组件不现实；缓存/预热都要动 pi 上游）：

- **零 realpathSync**：fork 树按 jsonl 文件名（basename）配对（uuid 全局唯一，
  symlink / Windows 反斜杠遗留路径都能配——内建 canonicalize 反而救不了后者）。
- **md 是唯一数据源**：frontmatter（id/cwd/started/ended/name/messages/`source`/
  `parent_session`）+ 正文（firstMessage / 全文语料）。jsonl 路径由
  `<sessionsRoot>/<sub>/<source>` 重建，**选中时才** existsSync（列表期 315 次
  syscall ≈7s 不值得）；jsonl 已删 → notify，md 归档仍在。
- **零运行时 pi 依赖**：组件只依赖注入的结构化 theme/keybindings 接口
  （`ctx.ui.custom` 工厂参数天然满足），node --test 直测。

## 改动清单

| 文件 | 改动 |
|------|------|
| `src/render/shared.ts` | frontmatter 新增 `parent_session`（fork 链）；`GARDEN_VERSION` → 0.7.3 |
| `src/session-list.ts` | **重写**：jsonl 头读 → garden md 解析（每 base 优选 l2>l3>l1>l0；同 session_id 去重：新命名优先、mtime 决胜；无 source 旧产物跳过） |
| `src/session-tree.ts` | 新增：fork 树（basename 配对 + 环防御）+ 搜索（fuzzy / `"phrase"` / `re:`，语法同内建） |
| `src/textwidth.ts` | 新增：ANSI 零宽 / CJK 宽字符 / 按列截断（对齐 pi-tui 语义，零依赖） |
| `extensions/garden-selector.ts` | 新增：自绘组件（LineInput / 树渲染 / scope 缓存 / 删除确认 / rename 模式）+ `deleteSessionFile`（trash→unlink）+ `deleteGardenOutputs`（按 session_id 清全部 md） |
| `extensions/garden.ts` | `/garden` 换新组件；`PI_GARDEN_SELECTOR=builtin` 回退官方组件；`convertSessionFile` 返回补 `base`；rename 后立即重转 md 同步新名 |
| `scripts/probe-selector.mjs` | 重写：headless 驱动新组件，真实数据 + 按键 + 性能预算断言 |
| 测试 | session-list 重写；新增 session-tree / garden-selector / textwidth；共 84 全过 |

## 实测（本机 drvfs，315 session）

| 指标 | 内建组件 | 自绘组件 |
|------|---------|---------|
| current scope 可用 | ~22s | **0.4-0.5s** |
| all scope 可用 | ~27s（382 文件更重） | **1.4s** |
| 首次渲染 | 含在上面 | 0.3-0.4ms |
| 搜索按键 | ~230ms + 清空重付 22s | <50ms（纯内存） |
| 切 scope（已加载） | 重付 22s | <5ms（缓存） |

`node scripts/probe-selector.mjs`：PASS，fork 树（含三级嵌套）渲染正确。

## 行为差异 / 已知取舍

- **未转换的 session 不再出现**在列表（md 是唯一数据源）。升级后需跑一次
  `/gardener-output all` 回填（本次交付已执行 `node src/cli.ts` 全量回填，
  315 更新 / 清理 31 个旧文件 / 0 失败）。无 `source` 字段的旧产物跳过。
- 裁剪：sort 三模式循环、named-only 过滤、path 显示开关（threaded + 搜索已覆盖）。
- 删除 = 删 jsonl（trash 优先）+ 清该 session 全部 md 产物（按 frontmatter
  session_id 反查，改名残留一并清）；内存移除，不做内建那样的全量重载。
- rename 后旧 slug 的 md 残留靠选择器去重隐藏，物理清理等下次 CLI / `all` 全量
  （`removeStaleOutputs` 语义不变）。
- 内建 `/resume` 依然慢（pi 自身 loader + 同一组件），本次不管；
  是否给上游提 issue（canonicalizePath 加缓存）待定。
- 沿旧：`ctx.switchSession` 无 cwdOverride，跨机器 session 切换报错只 notify。

## 验证

- `npm test` 84 全过（含新增 session-tree / garden-selector / textwidth 三组）。
- `node scripts/probe-selector.mjs` 真实数据 PASS。
- 待人工：pi 内 `/garden` 实际过一遍（搜索 / Tab / Ctrl+R / Ctrl+D / Enter 切换）。

### 窗口高度自适应

`maxVisible` 不再硬编码 10；根据终端高度动态计算（`getTerminalHeight()` 回退
`process.stdout.rows` 再回退 24），公式 `max(8, height - 10)`（留白 ≈ border×2
+ header + search + blank + hints）。终端 30 行时显示 20 条，24 行时 14 条。
