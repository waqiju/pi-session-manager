import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionText } from "../src/parser.ts";
import { renderL0 } from "../src/render/l0.ts";
import { renderL1 } from "../src/render/l1.ts";
import { renderL2 } from "../src/render/l2.ts";
import {
  COMPACTION_SUMMARY,
  EDIT_DIFF,
  FINAL_TEXT_T1,
  FINAL_TEXT_T2,
  FINAL_TEXT_T3,
  INTERMEDIATE_TEXT,
  READ_TRUNCATION_CONTENT,
  THINKING_TEXT,
  USER_PROMPT_1,
  buildSample,
  buildSampleJsonl,
} from "./sample.ts";

const { header, entries } = buildSample();
const parsed = parseSessionText(buildSampleJsonl());
const OPTS = { sourceName: "sample.jsonl" };

test("parser: header + entries 数量", () => {
  assert.equal(parsed.header?.id, "test-session-uuid");
  assert.equal(parsed.header?.cwd, "/tmp/proj");
  assert.equal(parsed.entries.length, 23);
});

// 新增：toolCall 数量变了（+edit:0），L2 工具行断言也要加；entries 数量 23
const TOOL_LINE_EDIT = "- 🔧 **edit** `/tmp/proj/a.svg`";

test("parser: 容忍残缺末行", () => {
  const p = parseSessionText(buildSampleJsonl() + '{"type":"message","id":"broken"');
  assert.equal(p.entries.length, 23);
});

const l0 = renderL0(parsed.header, parsed.entries, OPTS);
const l1 = renderL1(parsed.header, parsed.entries, OPTS);
const l2 = renderL2(parsed.header, parsed.entries, OPTS);

test("L0: 全量保留", () => {
  assert.ok(l0.includes("HEAD_MARKER") && l0.includes("TAIL_MARKER"));
  assert.ok(l0.includes("result padding line 100"), "toolResult 完整保留");
  assert.ok(!l0.includes("omitted"), "L0 不应有省略标记");
  assert.ok(l0.includes(THINKING_TEXT), "thinking 保留");
  assert.ok(l0.includes("thinking padding line 030"), "L0 thinking 完整");
  assert.ok(l0.includes("arg padding line 030"), "toolCall args 完整保留");
  assert.ok(l0.includes(USER_PROMPT_1));
  assert.ok(l0.includes("*[image: image/png"), "图片占位符");
  assert.ok(l0.includes(COMPACTION_SUMMARY), "compaction summary");
  assert.ok(l0.includes("跳回分支点"), "分支跳回提示");
  assert.ok(l0.includes("🔄 模型切换") && l0.includes("📛 会话命名") && l0.includes("🏷️ 标记"));
  assert.ok(l0.includes("Custom (my-ext)") && l0.includes("Custom Message (my-ext)"));
  assert.ok(l0.includes("💻 Bash"), "bashExecution 渲染");
  assert.ok(l0.includes("❌"), "isError 标记");
});
test("L0 frontmatter", () => {
  assert.ok(l0.startsWith("---\n"));
  assert.ok(l0.includes('level: "l0"'));
  assert.ok(l0.includes('session_id: "test-session-uuid"'));
  assert.ok(l0.includes('cwd: "/tmp/proj"'));
  assert.ok(l0.includes('name: "garden 开发会话"'));
  assert.ok(l0.includes('- "kimi-k3"'));
  assert.ok(l0.includes("user: 3"));
  assert.ok(l0.includes("assistant: 7"));
  assert.ok(l0.includes("toolResult: 4"));
  // tokens: 1100 + 2200 + 150(compaction)
  assert.ok(l0.includes("total: 3450"));
  assert.ok(l0.includes("cost_total: 2.01"));
  assert.ok(l0.includes('source: "sample.jsonl"'));
});

test("L1: toolResult line 级截断", () => {
  assert.ok(l1.includes("HEAD_MARKER"), "保留头部");
  assert.ok(l1.includes("TAIL_MARKER"), "保留尾部");
  assert.ok(l1.includes("result padding line 000"), "头部整行保留");
  assert.ok(!l1.includes("result padding line 100"), "中间被省略");
  assert.ok(l1.includes("... (omitted"), "有省略标记");
  assert.ok(l1.includes("181 lines"), "省略行数正确");
});

test("L1: 超长行 inline 截断（软断行）", () => {
  assert.ok(l0.includes(" w85 "), "L0 保留超长行中部");
  assert.ok(!l1.includes(" w85 "), "L1 超长行中部被省略");
  assert.ok(l1.includes("result padding line 005-long w0 w1 w2"), "超长行头部保留");
  assert.ok(l1.includes("w139"), "超长行尾部保留");
  assert.ok(/005-long( w\d+)+ \.\.\. \(omitted \d+ chars\) \.\.\. /.test(l1), "断在词边界 + inline marker");
});

test("L1: toolCall args 超长字符串 line 级截断", () => {
  assert.ok(l1.includes("arg padding line 002"), "args 头部整行保留");
  assert.ok(!l1.includes("arg padding line 030"), "args 中间被省略");
  assert.ok(l1.length < l0.length, "L1 比 L0 短");
});

test("L1: args JSON 物理行被 inline 封顶（stringify 转义合行）", () => {
  const m = l1.match(/"content": "arg padding[^\n]*/);
  assert.ok(m, "找到 write content 的 JSON 物理行");
  assert.ok(m[0].length <= 600, `物理行长度 ${m[0].length} 应被封顶`);
  assert.ok(m[0].includes("... (omitted"), "物理行上有 inline marker");
  assert.ok(m[0].includes("arg padding line 059"), "物理行尾部保留");
});

test("L1: thinking line 级截断（头尾保留）", () => {
  assert.ok(l1.includes("THINK_HEAD") && l1.includes("THINK_TAIL"), "thinking 头尾保留");
  assert.ok(l1.includes("thinking padding line 000"), "thinking 头部整行保留");
  assert.ok(!l1.includes("thinking padding line 030"), "thinking 中间被省略");
});

test("L2: 骨架", () => {
  assert.ok(l2.includes('level: "l2"'));
  assert.ok(l2.includes(USER_PROMPT_1), "user prompt 保留");
  assert.ok(l2.includes(FINAL_TEXT_T1), "轮1 最终答复保留");
  assert.ok(l2.includes(FINAL_TEXT_T2), "轮2 最终答复保留");
  assert.ok(l2.includes(FINAL_TEXT_T3), "轮3 最终答复保留");
  assert.ok(!l2.includes(INTERMEDIATE_TEXT), "中间 assistant 消息丢弃");
  assert.ok(!l2.includes("THINK_HEAD"), "thinking 丢弃");
  assert.ok(!l2.includes("HEAD_MARKER"), "toolResult 内容丢弃");
  assert.ok(l2.includes("- 🔧 **read** `/tmp/proj/package.json`"), "read 一行摘要");
  assert.ok(l2.includes("- 🔧 **write** `/tmp/proj/big.txt`"), "write 一行摘要");
  assert.ok(l2.includes("- 🔧 **bash** `ls -la /tmp/proj` ❌"), "报错工具行带 ❌");
  assert.ok(l2.includes(TOOL_LINE_EDIT), "edit 一行摘要");
  assert.ok(l2.includes(COMPACTION_SUMMARY), "compaction summary 保留");
  assert.ok(l2.includes("跳回分支点"), "分支提示保留");
});

test("方案B: details 策略", () => {
  // L0: read(冗余副本) 和 edit(diff) 的 details 都全量保留
  assert.ok(l0.includes(READ_TRUNCATION_CONTENT), "L0 read details 冗余副本保留");
  assert.ok(l0.includes("firstChangedLine"), "L0 edit details 保留");
  // L1: read(输出型) details 丢弃；edit 保留全量；空 details 不渲染
  assert.ok(!l1.includes(READ_TRUNCATION_CONTENT), "L1 read details 丢弃");
  assert.ok(!l1.includes("truncation"), "L1 无 truncation 键");
  assert.ok(l1.includes("firstChangedLine"), "L1 edit details 保留");
  // 空 details（bash {}）任何级别都不渲染
  assert.ok(!l0.includes("**details:**\n\n\n\n```json\n{}"), "L0 不渲染空 details");
  assert.ok(!l1.includes("**details:**\n\n\n\n```json\n{}"), "L1 不渲染空 details");
});

test("details 块渲染：多行字符串不再转义单行（2026-09-14）", () => {
  // L0: diff/patch 全字段块渲染
  assert.ok(l0.includes("```text\n" + EDIT_DIFF + "\n```"), "L0 diff 为 text 围栏块");
  assert.ok(l0.includes("```diff\n--- a.svg\n+++ b.svg\n@@ -27,6 +27,6 @@\n```"), "L0 patch 为 diff 围栏块");
  assert.ok(l0.includes("**details:** (firstChangedLine: 31)"), "标量并入头行");
  assert.ok(!l0.includes('\\n+++'), "L0 无转义单行");
  // L1: patch 优先去重（diff 的绝对行号翻 l0）
  assert.ok(l1.includes("```diff\n--- a.svg\n+++ b.svg\n@@ -27,6 +27,6 @@\n```"), "L1 patch 为 diff 围栏块");
  assert.ok(!l1.includes(EDIT_DIFF), "L1 有 patch 时 diff 去重");
  assert.ok(!l1.includes('\\n+++'), "L1 无转义单行");
  assert.ok(!/"patch": "/.test(l1), "L1 details 不再是 JSON 形态");
});

test("details 块渲染：无 patch 时 L1 退到 diff 块", () => {
  const u = {
    type: "message", id: "u1", parentId: null, timestamp: "2026-09-14T01:00:00.000Z",
    message: { role: "user", content: "x" },
  };
  const r = {
    type: "message", id: "r1", parentId: "u1", timestamp: "2026-09-14T01:00:01.000Z",
    message: {
      role: "toolResult", toolCallId: "e0", toolName: "edit",
      content: [{ type: "text", text: "ok" }],
      details: { diff: EDIT_DIFF, firstChangedLine: 31 },
      isError: false,
    },
  };
  const md = renderL1(null, [u as never, r as never]);
  assert.ok(md.includes("```text\n" + EDIT_DIFF + "\n```"), "diff 退化为 text 围栏块");
  assert.ok(!md.includes("```diff"), "无 patch 不出 diff 围栏");
  assert.ok(md.includes("(firstChangedLine: 31)"), "标量仍在头行");
});

test("L2: 工具行在最终答复之前", () => {
  const iTool = l2.indexOf("- 🔧 **read**");
  const iText = l2.indexOf(FINAL_TEXT_T1);
  assert.ok(iTool > -1 && iText > -1 && iTool < iText);
});

test("L2: turn 编号 + 轮级耗时/output tokens（2026-09-14）", () => {
  assert.ok(l2.includes("## 👤 User · #1 · 01:00:04"), "user 头带 turn 编号");
  assert.ok(l2.includes("## 👤 User · #3 · 01:00:22"), "compaction 后编号连续");
  // 轮1：eUser1(04s) → eA4(13s) = 9s；usage.output = 100 + 200 = 300
  assert.ok(l2.includes("## 🤖 Assistant · 01:00:13 · kimi-k3 · ⏱ 9s · out 300"), "轮1 耗时+token");
  // 轮2：eUser2(14s) → eBashExec(17s) = 3s；无 usage → 不显 out
  assert.ok(l2.includes("## 🤖 Assistant · 01:00:16 · kimi-k3 · ⏱ 3s\n"), "轮2 只显耗时");
  // 轮3：eUser3(22s) → eA6(23s) = 1s
  assert.ok(l2.includes("## 🤖 Assistant · 01:00:23 · kimi-k3 · ⏱ 1s\n"), "轮3 只显耗时");
});

test("渲染确定性：两次结果一致", () => {
  assert.equal(renderL0(header, entries, OPTS), l0);
  assert.equal(renderL2(header, entries, OPTS), l2);
});
