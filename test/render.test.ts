import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionText } from "../src/parser.ts";
import { renderL0 } from "../src/render/l0.ts";
import { renderL1 } from "../src/render/l1.ts";
import { renderL2 } from "../src/render/l2.ts";
import { renderL3 } from "../src/render/l3.ts";
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
const l3 = renderL3(parsed.header, parsed.entries, OPTS);

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
  assert.ok(l2.includes(INTERMEDIATE_TEXT), "中间 assistant text 保留（承上启下）");
  assert.ok(!l2.includes("THINK_HEAD"), "thinking 内容丢弃");
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

test("L1: 超长会话名 inline 截断（l0 全量保留）", () => {
  // pi-ssh-remote 会把首条 prompt 全文拼进会话名（实测 242 字符）
  const longName = "SSH m106:/Users/plato/1_Workspace/mi-cloud-sync (main) • " + "需要新增个功能 ".repeat(30);
  const si = { type: "session_info", id: "s1", parentId: null, timestamp: "2026-09-14T01:00:00.000Z", name: longName };
  const md0 = renderL0(null, [si as never]);
  const md1 = renderL1(null, [si as never]);
  // 注意：frontmatter 的 name 字段本来就是全量，必须只查正文中的「会话命名」行
  const line0 = md0.split("\n").find((l) => l.includes("会话命名"));
  const line1 = md1.split("\n").find((l) => l.includes("会话命名"));
  assert.ok(line0?.includes(longName), "l0 行内全量保留");
  assert.ok(line1 && !line1.includes(longName), "l1 行内截断");
  assert.ok(line1?.includes("SSH m106:"), "头部保留");
  assert.ok(line1?.includes("... (omitted"), "有 inline marker");
  assert.ok(line1 && line1.length < 200, `截后行长 ${line1?.length} 有界`);
});

test("L2: turn 编号 + 轮级耗时/output tokens（2026-09-14）", () => {
  assert.ok(l2.includes("## 👤 User · #1 · 01:00:04"), "user 头带 turn 编号");
  assert.ok(l2.includes("## 👤 User · #3 · 01:00:22"), "compaction 后编号连续");
  // 轮1：eUser1(04s) → eA4(13s) = 9s；usage.output = 100 + 200 = 300；标题时间 = 轮内首条 assistant(eA1, 05s)
  assert.ok(l2.includes("## 🤖 Assistant · 01:00:05 · kimi-k3 · ⏱ 9s · out 300"), "轮1 耗时+token");
  // 轮2：eUser2(14s) → eBashExec(17s) = 3s；无 usage → 不显 out
  assert.ok(l2.includes("## 🤖 Assistant · 01:00:16 · kimi-k3 · ⏱ 3s\n"), "轮2 只显耗时");
  // 轮3：eUser3(22s) → eA6(23s) = 1s
  assert.ok(l2.includes("## 🤖 Assistant · 01:00:23 · kimi-k3 · ⏱ 1s\n"), "轮3 只显耗时");
});

test("L2: thinking 占位 + text 与工具按序交织（2026-09-14）", () => {
  assert.ok(l2.includes("**🧠 Thinking**"), "thinking 占位保留");
  // 顺序：thinking 占位 → 中间 text → 工具行 → 最终 text
  const iThink = l2.indexOf("**🧠 Thinking**");
  const iMid = l2.indexOf(INTERMEDIATE_TEXT);
  const iTool = l2.indexOf("- 🔧 **read**");
  const iFinal = l2.indexOf(FINAL_TEXT_T1);
  assert.ok(iThink > -1 && iThink < iMid && iMid < iTool && iTool < iFinal, "占位→中间text→工具→最终text 按序");
});

test("L3: 纯问答视图（每轮只留最终答复）", () => {
  assert.ok(l3.includes('level: "l3"'));
  assert.ok(l3.includes(USER_PROMPT_1), "user prompt 保留");
  assert.ok(l3.includes("## 👤 User · #1 · 01:00:04"), "turn 编号保留");
  assert.ok(l3.includes(FINAL_TEXT_T1), "轮1 最终答复保留");
  assert.ok(l3.includes(FINAL_TEXT_T2), "轮2 最终答复保留");
  assert.ok(l3.includes(FINAL_TEXT_T3), "轮3 最终答复保留");
  assert.ok(!l3.includes(INTERMEDIATE_TEXT), "中间 assistant text 丢弃");
  assert.ok(!l3.includes("**🧠 Thinking**"), "thinking 占位丢弃");
  assert.ok(!l3.includes("🔧"), "工具行（含 ❌ 报错标记）丢弃");
  assert.ok(!l3.includes("echo hi"), "bashExecution 行丢弃");
  assert.ok(l3.includes(COMPACTION_SUMMARY), "compaction summary 保留");
  assert.ok(l3.includes("跳回分支点"), "分支提示保留");
  // 节标题与轮级统计同 l2 完全一致（时间 = 轮内首条 assistant）
  assert.ok(l3.includes("## 🤖 Assistant · 01:00:05 · kimi-k3 · ⏱ 9s · out 300"), "节标题+统计同 l2");
  assert.ok(l3.length < l2.length, "L3 比 L2 短");
});

test("L3: 边界——轮内向前取最后 text / 无 text 轮省略 assistant 节", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-14T01:00:00.000Z") + s * 1000).toISOString();
  const mk = (id: string, parentId: string | null, sec: number, message: unknown) =>
    ({ type: "message", id, parentId, timestamp: t(sec), message });
  const entries = [
    // 轮1：a1 有 text + toolCall，a2（最后一条）只有 toolCall → 向前取 a1 的 text
    mk("u1", null, 0, { role: "user", content: "q1" }),
    mk("a1", "u1", 1, { role: "assistant", content: [
      { type: "text", text: "早期答复" },
      { type: "toolCall", id: "t:0", name: "bash", arguments: { command: "ls" } },
    ], model: "m", stopReason: "toolUse" }),
    mk("r1", "a1", 2, { role: "toolResult", toolCallId: "t:0", toolName: "bash", content: [{ type: "text", text: "ok" }] }),
    mk("a2", "r1", 3, { role: "assistant", content: [
      { type: "toolCall", id: "t:1", name: "bash", arguments: { command: "pwd" } },
    ], model: "m", stopReason: "toolUse" }),
    mk("r2", "a2", 4, { role: "toolResult", toolCallId: "t:1", toolName: "bash", content: [{ type: "text", text: "ok" }] }),
    // 轮2：assistant 整轮无 text（abort 型）→ 节省略，统计退化为 meta 行
    mk("u2", "r2", 10, { role: "user", content: "q2" }),
    mk("a3", "u2", 11, { role: "assistant", content: [
      { type: "toolCall", id: "t:2", name: "bash", arguments: { command: "rm" } },
    ], model: "m", stopReason: "toolUse", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }),
    mk("r3", "a3", 13, { role: "toolResult", toolCallId: "t:2", toolName: "bash", content: [{ type: "text", text: "ok" }] }),
    // 轮3：正常最终答复
    mk("u3", "r3", 20, { role: "user", content: "q3" }),
    mk("a4", "u3", 21, { role: "assistant", content: [{ type: "text", text: "最终答复" }], model: "m", stopReason: "stop" }),
  ];
  const md = renderL3(null, entries as never);
  const iU1 = md.indexOf("## 👤 User · #1");
  const iU2 = md.indexOf("## 👤 User · #2");
  const iU3 = md.indexOf("## 👤 User · #3");
  const turn1 = md.slice(iU1, iU2);
  assert.ok(turn1.includes("早期答复"), "最后一条无 text 时向前找轮内最近 text");
  assert.ok(!turn1.includes("🔧"), "工具行不出现");
  const turn2 = md.slice(iU2, iU3);
  assert.ok(!turn2.includes("## 🤖 Assistant"), "无 text 轮省略 assistant 节");
  assert.ok(turn2.includes("> ⏱ 3s · out 5"), "统计退化为独立 meta 行");
  assert.ok(md.includes("最终答复"), "轮3 正常");
  assert.equal(md.match(/## 🤖 Assistant/g)?.length, 2, "全文只有两个 assistant 节");
});

test("渲染确定性：两次结果一致", () => {
  assert.equal(renderL0(header, entries, OPTS), l0);
  assert.equal(renderL2(header, entries, OPTS), l2);
  assert.equal(renderL3(header, entries, OPTS), l3);
});
