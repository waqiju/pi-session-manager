# Handoff: edit details 块渲染 + L2 turn 统计

- 日期：2026-09-14
- 项目：garden（pi-session-manager）
- 状态：已完成；对应代码状态 `GARDEN_VERSION = 0.6.1`
- 上一棒：[2026-09-14-l1-optimization-and-next-steps.md](2026-09-14-l1-optimization-and-next-steps.md)

## 1. 本轮完成

上一棒「下一步优化方向」中的两项，经调查讨论后由用户拍板实施：

### ⑤ edit diff 可读性渲染（方案：L0 块渲染 + L1 patch 优先去重）

调查发现：非空 details 只出现在 edit（1139 次）/bash/read，多行字符串字段只有
`edit.diff`（100%）与 `edit.patch`（77%）——通用机制无现实收益，edit 专用即够。

实现（`src/render/full.ts` `renderDetails()`）：

- 多行字符串值渲染为围栏块（真实换行，不再转义 JSON 单行）：`patch` 用 ```` ```diff ````
  高亮，其余用 ```` ```text ````
- 嵌套对象/数组 → JSON 围栏块；标量并入头行 `**details:** (firstChangedLine: 31)`
- **L1 去重**：`patch` 存在时跳过等价的 `diff`（同一修改的两种表示；
  diff 的绝对行号仍可翻 l0）；无 `patch` 时退到 `diff` 块
- 截断正交：字符串值仍先按 `DETAILS_BUDGET=4000` 做 line 级截断再渲染成块
- L0 同样应用块渲染（无损，只是不再转义）

### ④b L2 turn 编号 + 轮级耗时/token

实现（`src/render/l2.ts`）：

- user 节标题带编号：`## 👤 User · #3 · 15:34:39`（compaction 不重置）
- assistant 节标题带轮级统计：`## 🤖 Assistant · 15:36:33 · kimi-k3 · ⏱ 2.6m · out 5.3k`
  - 耗时 = 轮内最后一个「干活」entry（assistant/toolResult/bashExecution）− user 起点，
    不含轮间用户离开时间
  - `out` = 轮内 assistant `usage.output` 求和（不含 cache；紧凑格式 300 / 5.3k / 1.2M）；
    无 usage 不显
  - 一轮无含 text 的 assistant 时退化为独立行 `> ⏱ 26s · out 485`
  - 一轮只显一次（compaction 中途 flush 不重复）

### ④a 连续同类工具行折叠：**不做**

用户判断：10 行折到 3 行不占大头，l2 体积大头在 user prompt 和 assistant text。
（调查数据：54 个 l2 文件 ≥3 连 run 516 个，可省 ~2549 行——结论仍是收益不值得复杂度。）

### ⑥ l2 text 全量 + thinking 占位（0.6.0，同日追加）

用户复查 0.5.0 输出后提出两处调整：

- **assistant text 全量保留**：原为每轮只留最后一条含 text 的消息。用户理由：从 l0 看，
  中间 text 都很简短但承上启下，有助理解。现按时间序与工具行交织（连续的 tool 行仍并为一组
  list）；每轮一个 assistant 节，标题时间/模型改为轮内**首条** assistant。
- **thinking 占位**：原为丢弃。现保留占位段落 `**🧠 Thinking**`（内容仍丢弃），
  表示模型在此思考过。

实现：`l2.ts` 的 `toolBuf`+`pendingText` 双缓冲改为单一 `turnItems` 有序列表
（tool/block 两类），flush 时连续 tool 并组；❌ 回补仍走 toolCallId → 下标。

## 2. 验证

- `npm test`：31 个测试全过（新增 4 个：块渲染 L0/L1、无 patch 退化、turn 统计、
  thinking 占位与交织顺序）
- 全量重生成（删 garden/ 后 `node src/cli.ts`，305 session）：抽查
  `~/.pi/agent/garden/--mnt-d-1_Workspace-bot_home--/2026-09-05T15-04-09-626Z_....md`
  l1 的 patch 红绿 diff 块、l2 的 `#N` 编号与 `⏱/out` 均正常

## 3. 文档更新

- `wiki/internals/reference/output-format.md`：details 块渲染规则 + l2 turn 编号/统计
- `wiki/internals/reference/constants.md`：版本历史加 0.5.0
- `wiki/internals/concepts/lod-levels.md`：取舍表更新（l2 text 全量 / thinking 占位）
- `wiki/internals/concepts/truncation.md`：JSON 物理行说明更新（details 多行值不再走 JSON）
- `python3 scripts/check_wiki_links.py` 通过

## 4. 追加：会话命名异常调查（0.6.1）

用户报告某 session 的 l1 里出现多条「会话命名」且名字混入 user prompt，怀疑转换错误。
调查结论：**garden 渲染忠实，非转换 bug**：

- 多次命名来源：`@99percentpeople/pi-ssh-remote` 扩展的自动命名——SSH 连接时命名
  `SSH <target>:<cwd>` → 检测到 git branch 后重命名加 `(main)` → 首条 user 消息的
  `message_end` 时把 **prompt 全文**（`GK()` 提取，无截断）拼为 `... (main) • <prompt>`。
  另有 `JX` 守卫：手动 `/name` 后不再自动改。
- 为什么格外多：该 session 是从 09-05 会话 fork 的（header.parentSession 确认），
  文件开头继承了旧会话的 3 条命名记录，加上新会话自己的 3 条 + 手动 `/name to-delete`。
- 修复（garden 侧，防御性）：l1 中 session_info 的 name 做 inline 封顶
  （新常量 `SESSION_NAME_BUDGET = 100`），l0 全量保留。frontmatter `name` 不受影响
  （取最后一条 session_info，本会话即手动名 `to-delete`）。
- 源头建议（未实施）：pi-ssh-remote 的 `GK()` 拼接 prompt 前应截断（如 50 字符）。
  该包发布的是 minified dist（npm `@99percentpeople/pi-ssh-remote`@0.6.2），
  补丁需打到上游源码 github.com/99percentpeople/pi-extensions/tree/main/extensions/ssh-remote。

## 5. 遗留（沿上一棒）

- ① garden 索引（推荐下轮做）、② 按价值分配预算（isError 加倍等）、③ pi 接入
- 挂起：嵌套目录递归扫描方案 A（保持不递归）仍待用户拍板
