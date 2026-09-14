# pi session 格式（garden 依赖的概念）

> 精确的字段级字典以 pi 官方文档为准（`pi-coding-agent/docs/session-format.md`，
> 随 pi 版本演进，本页不复制）。本页只讲 garden 渲染所依赖的概念。

## 文件形态

```
~/.pi/agent/sessions/--<cwd 把 / 换成 -->--/<timestamp>_<uuid>.jsonl
```

每行一个 JSON 对象（JSONL），第一个对象是 session header（`type: "session"`，
含 `version` / `id` / `cwd` / `timestamp`），其余是 entry。

garden 的 parser 容忍**追加到一半的残缺末行**（JSON.parse 失败即跳过）——
转换正在写入中的活跃 session 时必然遇到。

## entry 类型（v3）

| type | garden 的处理 |
|------|--------------|
| `message` | 主体。`message.role` ∈ `user` / `assistant` / `toolResult` / `bashExecution` / `custom` / `branchSummary` / `compactionSummary` |
| `compaction` | 上下文压缩点，`summary` 很宝贵（l0~l2 都保留） |
| `branch_summary` | 分支切换时对被放弃路径的总结（保留） |
| `model_change` / `thinking_level_change` | 一行记录 |
| `session_info` | session 名，进 frontmatter |
| `label` / `custom` / `custom_message` | 一行记录或小节 |

assistant 消息的 `content` 是 part 数组：`thinking` / `text` / `toolCall`（args 为完整 JSON）。
未知类型走 `renderEntry` 的 default 分支渲染为「❓ 未知 entry」——这是跟进新类型的哨兵
（流程见 wiki/internals/tasks/add-entry-type.md）。

## tree 结构与 garden 的线性化

entry 经 `id` / `parentId` 组成**树**（分支：用户回退后继续对话）。
garden 不做树重建，按**文件 append 顺序**渲染全部四级，理由：

- 文件顺序 = 事件发生的时间顺序，本身是忠实日志
- 分支的实际形态是 `...A1, A2, A3（废弃支）, branch_summary, B1, B2...`，
  线性读唯一的障碍是「突然跳回过去」
- 因此渲染时检测 `entry.parentId != 上一条 entry.id`，插入
  `> ⑂ 跳回分支点 \`<id>\`` 提示，配合 branch_summary 即可读懂

l2 同样按文件顺序（废弃分支里的 user prompt 也有信息量：能看出「试过什么又放弃了」）。
