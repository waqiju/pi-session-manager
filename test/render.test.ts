import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionText } from "../src/parser.ts";
import { renderL0 } from "../src/render/l0.ts";
import { renderL1 } from "../src/render/l1.ts";
import { renderL2 } from "../src/render/l2.ts";
import {
  COMPACTION_SUMMARY,
  FINAL_TEXT_T1,
  FINAL_TEXT_T2,
  FINAL_TEXT_T3,
  INTERMEDIATE_TEXT,
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
  assert.equal(parsed.entries.length, 21);
});

test("parser: 容忍残缺末行", () => {
  const p = parseSessionText(buildSampleJsonl() + '{"type":"message","id":"broken"');
  assert.equal(p.entries.length, 21);
});

const l0 = renderL0(parsed.header, parsed.entries, OPTS);
const l1 = renderL1(parsed.header, parsed.entries, OPTS);
const l2 = renderL2(parsed.header, parsed.entries, OPTS);

test("L0: 全量保留", () => {
  assert.ok(l0.includes("HEAD_MARKER") && l0.includes("TAIL_MARKER"));
  assert.ok(l0.includes("x".repeat(5000)), "toolResult 完整保留");
  assert.ok(!l0.includes("省略"), "L0 不应有省略标记");
  assert.ok(l0.includes(THINKING_TEXT), "thinking 保留");
  assert.ok(l0.includes("W".repeat(3000)), "toolCall args 完整保留");
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
  assert.ok(l0.includes("assistant: 6"));
  assert.ok(l0.includes("toolResult: 3"));
  // tokens: 1100 + 2200 + 150(compaction)
  assert.ok(l0.includes("total: 3450"));
  assert.ok(l0.includes("cost_total: 2.01"));
  assert.ok(l0.includes('source: "sample.jsonl"'));
});

test("L1: toolResult 头尾截断", () => {
  assert.ok(l1.includes("HEAD_MARKER"), "保留头部");
  assert.ok(l1.includes("TAIL_MARKER"), "保留尾部");
  assert.ok(!l1.includes("x".repeat(5000)), "中间被省略");
  assert.ok(l1.includes("省略"), "有省略标记");
});

test("L1: toolCall args 超长字符串截断，thinking 全量", () => {
  assert.ok(!l1.includes("W".repeat(3000)), "write content 被截断");
  assert.ok(l1.includes(THINKING_TEXT), "thinking 全量保留");
  assert.ok(l1.length < l0.length, "L1 比 L0 短");
});

test("L2: 骨架", () => {
  assert.ok(l2.includes('level: "l2"'));
  assert.ok(l2.includes(USER_PROMPT_1), "user prompt 保留");
  assert.ok(l2.includes(FINAL_TEXT_T1), "轮1 最终答复保留");
  assert.ok(l2.includes(FINAL_TEXT_T2), "轮2 最终答复保留");
  assert.ok(l2.includes(FINAL_TEXT_T3), "轮3 最终答复保留");
  assert.ok(!l2.includes(INTERMEDIATE_TEXT), "中间 assistant 消息丢弃");
  assert.ok(!l2.includes(THINKING_TEXT), "thinking 丢弃");
  assert.ok(!l2.includes("HEAD_MARKER"), "toolResult 内容丢弃");
  assert.ok(l2.includes("- 🔧 **read** `/tmp/proj/package.json`"), "read 一行摘要");
  assert.ok(l2.includes("- 🔧 **write** `/tmp/proj/big.txt`"), "write 一行摘要");
  assert.ok(l2.includes("- 🔧 **bash** `ls -la /tmp/proj` ❌"), "报错工具行带 ❌");
  assert.ok(l2.includes(COMPACTION_SUMMARY), "compaction summary 保留");
  assert.ok(l2.includes("跳回分支点"), "分支提示保留");
});

test("L2: 工具行在最终答复之前", () => {
  const iTool = l2.indexOf("- 🔧 **read**");
  const iText = l2.indexOf(FINAL_TEXT_T1);
  assert.ok(iTool > -1 && iText > -1 && iTool < iText);
});

test("渲染确定性：两次结果一致", () => {
  assert.equal(renderL0(header, entries, OPTS), l0);
  assert.equal(renderL2(header, entries, OPTS), l2);
});
