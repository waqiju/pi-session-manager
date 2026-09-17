# 反向同步（index.md → sessions）

garden 原本是单向的（sessions jsonl → garden md）。反向同步是唯一回写通道：
人工编辑 `garden/<sub>/index.md` 后，在 `/garden` 选择器按 **Ctrl+G** 把编辑应用回 sessions。

## 支持的编辑

| 编辑 | 效果 |
|------|------|
| 调整行缩进（每级两空格） | 换父：重写 jsonl 首行 header 的 `parentSession`（提根 = 删字段） |
| 行尾加 `to-delete` | 删除：jsonl（trash 优先）+ 全部 garden md 产物（与 Ctrl+D 同路径） |
| 行尾加 `to-archive` | 归档：jsonl 挪到同目录 `1_archived/` 子目录（不存在则新建），garden md 删除 |

标记必须**小写**、位于行尾元数据反引号块之后（前后空格可选）。label 文本允许改但不生效
（身份只认链接 href 推出的 mdBase）。会话叫 `to-delete` 不受影响——标记位置在 label 之外。

## 执行流程（Ctrl+G）

1. **prepare**：解析 index.md 条目行 → 与 sessions 一一对账（href 全部可匹配、无重复、
   无缺失；数量与 id 集合一致）。任何不一致**中止**，提示先 `/gardener-output index`
   重新生成再编辑——索引与实况有偏差时人是在旧副本上编辑，应用必然出错。
2. **确认条**：`应用反向同步: N 换父 · M 删除 · K 归档[ · D 脱钩为根] — Enter 确认 · Esc 取消`。
   全零（无换父无标记）不进确认条，直接提示无需同步。
3. **apply**：删除 → 归档 → 换父 → 重建 index.md（固化新树、消费掉标记）。
   当前活跃 session 禁止删除/归档（运行中的 pi 用 appendFileSync 追加，文件被挪走
   会在原路径重建新 jsonl）；换父不受限。全部删除/归档完时 index.md 一并移除。

## 语义细节

- **父删子留**：未标记节点的父行被标记删除/归档 → 该节点**脱钩为根**（显式把
  `parentSession` 置 null，比留悬空引用干净；确认条会计数提示）。
- **归档身份保留**：归档的 jsonl header 追加 `archivedTreePath`（根到自身的名称路径，
  如 `"PSM / pi-集成 / copy-subtree"`）与 `archivedAt`（ISO 时间戳）。恢复时即使父会话
  已消失，也能认出它在树中的原位置。
- **`1_archived/` 天然隐身**：pi 的 session 发现与 garden 的 `collectJobs` 都只扫
  `sessions/<sub>/` 一层，归档子目录不会被列举或重新转换；选择器/index 的数据源是
  garden md，产物删除后即消失。

## 安全前提（已核实 pi 实现）

- pi 追加写 jsonl 是 `appendFileSync`（每次重新打开，无缓存偏移）→ 重写首行 header
  不破坏运行中 session 的后续追加；写盘走临时文件 + rename，防半截写入。
- pi 解析 header 只校验 `type === "session"` 与 `id` 存在，**容忍额外字段**
  （其源码注释明确提到 custom metadata fields）→ `archivedTreePath/archivedAt` 不影响加载。
- 重写前校验 header `id` 与预期一致，不符拒改。

## 关键连锁：换父后必须立即重转 md

index.md 与选择器的树来自 garden md frontmatter 的 `parent_session`，不是实时的 jsonl。
反向同步改完 jsonl 后会对换父的 session 立即重转（jsonl 重写后 mtime 变新，增量判断
自动判过期）——否则下次重建 index 又显示旧树，人工编辑看似丢失。

## 代码位置

- `src/reverse-sync.ts`：解析（`parseIndexRows`）、对账与计划（`planReverseSync`）、
  fs 操作（`rewriteSessionParent` / `archiveSessionFile`），零依赖可直测。
- `extensions/garden.ts`：prepare/apply 闭包接线（plan 暂存，Enter 后消费）。
- `extensions/garden-selector.ts`：Ctrl+G 键位、确认条、apply 后重载列表。

相关：[system-map](system-map.md)、[extension 参考](../reference/extension.md)、
[session-format](session-format.md)。
