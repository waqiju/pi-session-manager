# 跟进 pi 新增 entry 类型（add-entry-type）

pi 演进会新增 session entry 类型或 message role（session-format 版本升级）。
garden 的 `renderEntry` / `renderMessage` default 分支会把未知类型渲染成
「❓ 未知 entry」小节——这是发现新类型的哨兵。

## Before You Begin

- 拿到新类型的定义：pi 官方 `docs/session-format.md`，或一份含新类型的真实 session jsonl
- 读过 wiki/internals/concepts/session-format.md（garden 对格式的消费方式）

## Steps

1. `src/types.ts`：补类型定义（注意：本仓库用 type-stripping，只允许可擦除语法）
2. `src/render/full.ts`：`renderEntry`（新 entry 类型）或 `renderMessage`（新 message role）
   加分支——决定 l0/l1 怎么渲染（参考取舍表：wiki/internals/concepts/lod-levels.md）
3. `src/render/skeleton.ts`：决定骨架级（l2/l3）是否保留（默认忽略；若像 compaction 一样关键则保留摘要）
4. `test/sample.ts`：fixture 补一个新类型实例；`render.test.ts` 补断言
   （entries 总数断言也要 +1）
5. `npm test`，然后 bump `GARDEN_VERSION` 并全量重生成（见 Related 的 tune-budget）

## Verify

- `grep -rn "❓ 未知" ~/.pi/agent/garden --include="*.l1.md" | head` 无新增
- 用一个含新类型的真实 session 单独转换并人工抽查四级输出

## Troubleshooting

| 问题 | 处理 |
|------|------|
| 不确定新类型长什么样 | 在真实 sessions 里 grep：`<jsonl文件>` 中按 `"type":` 去重统计 |
| 新类型影响 token 统计 | 检查 `shared.ts` 的 `collectStats`（usage 只在 message / compaction / branch_summary 上累加） |
| 渲染后增量没生效 | bump `GARDEN_VERSION`（wiki/internals/tasks/tune-budget.md） |

## Related

- wiki/internals/concepts/session-format.md — 格式概念与线性化策略
- wiki/internals/tasks/tune-budget.md — 全量重生成流程
- wiki/internals/reference/output-format.md — 输出格式字典
