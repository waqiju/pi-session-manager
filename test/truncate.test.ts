import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateEachLine, truncateInline, truncateLines, truncateLongStrings } from "../src/render/truncate.ts";

test("短文本原样返回（块级阈值）", () => {
  const t = "line1\nline2";
  assert.equal(truncateLines(t, 100), t);
  assert.equal(truncateLines(t, 11), t, "恰好等于预算也不截断");
});

test("6:4 头尾整行截断 + marker 精确", () => {
  // 30 行 × 10 字符 → 329 字符，预算 100（头 60 / 尾 40）
  const lines = Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")}abcdefg`);
  const text = lines.join("\n");
  assert.equal(text.length, 329);
  const out = truncateLines(text, 100);
  // head: 每行 11 单位，6 行累计 66 ≥ 60 → 取 6 行（0..5）
  // tail: 4 行累计 44 ≥ 40 → 取 4 行（26..29）
  const outLines = out.split("\n");
  assert.equal(outLines[0], lines[0]);
  assert.equal(outLines[5], lines[5], "头部到第 6 行");
  assert.ok(!out.includes(lines[6]), "第 7 行被省略");
  assert.ok(out.endsWith(lines.slice(26).join("\n")), "尾部为最后 4 行");
  assert.ok(out.includes("... (omitted 221 chars / 20 lines) ..."), "marker 字符/行数正确");
});

test("跨界行完整保留（宁多不少，绝不截在行中间）", () => {
  const first = "x".repeat(70); // 首行 70 字符，一行就超过 head 预算 60
  const text = [first, ...Array.from({ length: 20 }, (_, i) => `pad${String(i).padStart(2, "0")}`), "last"].join("\n");
  const out = truncateLines(text, 100);
  assert.ok(out.startsWith(first), "70 字符的首行完整保留");
  assert.ok(out.includes("omitted"), "其余部分被截断");
});

test("头尾重叠 → 返回原文（不做无意义截断）", () => {
  const lines = ["a".repeat(30), "b".repeat(30), "c".repeat(30), "d".repeat(30)];
  const text = lines.join("\n"); // 127 > 100，但头 2 行 + 尾 2 行已覆盖全部
  assert.equal(truncateLines(text, 100), text);
});

test("单行超长：先被 inline 截断，再整块放行", () => {
  // 600 字符单行（有分隔符）→ inline 截断后仍超预算 100 → 单行重叠 → 返回 inline 截断结果
  const out = truncateLines("z ".repeat(300), 100);
  assert.ok(out.includes("(omitted 99 chars)"), "inline 截断生效");
  assert.ok(!out.includes("lines)"), "单行块无 line 级 marker");
  assert.ok(out.length < 600, "结果比原行短");
  // 无分隔符的行：永不硬切，整行保留
  assert.equal(truncateLines("z".repeat(600), 100), "z".repeat(600));
  // 恰好在 inline 限额内（500）的单行：保持完整
  assert.equal(truncateLines("z".repeat(500), 100), "z".repeat(500));
});

test("truncateInline: 软断行（head 向后、tail 向前找分隔符）", () => {
  const line = "w ".repeat(400); // 800 字符，空格在奇数位
  const out = truncateInline(line, 500);
  // head 300 → 空格在 301 → cut=301；tail 起点 600 → 空格在 599 → tailFrom=600
  // omitted = 600-301 = 299
  assert.ok(out.includes("(omitted 299 chars)"));
  assert.ok(out.endsWith(line.slice(600)), "tail 从分隔符后开始，不硬切");
  assert.ok(!/\s$/.test(out.split(" ... ")[0]), "head 断在分隔符前");
});

test("truncateInline: 无分隔符 → 整行保留（永不硬切）", () => {
  const line = "x".repeat(700);
  assert.equal(truncateInline(line, 500), line);
});

test("truncateInline: 省略量过小则不截", () => {
  const line = "a".repeat(300) + " " + "b".repeat(209); // 510 字符，断点交叉/省略量=1
  assert.equal(truncateInline(line, 500), line);
});

test("truncateEachLine: 只封顶长物理行，其他不动", () => {
  const text = `short\n${"x ".repeat(350)}\nalso short`;
  const out = truncateEachLine(text, 500);
  const lines = out.split("\n");
  assert.equal(lines[0], "short");
  assert.ok(lines[1].includes("(omitted 199 chars)"));
  assert.equal(lines[2], "also short");
});

test("inline + line 两层组合：每行封顶且块预算生效", () => {
  // 30 行 × 604 字符（有分隔符 → 每行 inline 到 ~530）
  const lines = Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")} ` + "ab ".repeat(200));
  const out = truncateLines(lines.join("\n"), 1000);
  const inlineCount = (out.match(/\(omitted 103 chars\)/g) ?? []).length;
  assert.equal(inlineCount, 3, "保留的 3 行各有 inline marker");
  assert.ok(out.includes("chars / 27 lines"), "line 级省略 27 行");
});

test("truncateLongStrings: 深遍历 JSON，只截超长字符串", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")} ${"y".repeat(20)}`).join("\n"); // 1199 字符
  const obj = { a: long, b: 123, c: ["short", long], d: { e: null } };
  const out = truncateLongStrings(obj, 800) as any;
  assert.ok(out.a.includes("omitted"), "顶层字符串被截断");
  assert.equal(out.b, 123, "数字不动");
  assert.equal(out.c[0], "short", "短字符串不动");
  assert.ok(out.c[1].includes("omitted"), "数组内字符串被截断");
  assert.deepEqual(out.d, { e: null }, "嵌套对象保持");
});

test("headRatio 可调", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")}abcdefg`);
  const text = lines.join("\n");
  const out = truncateLines(text, 100, { headRatio: 0.5 });
  // head 50 → 5 行(55)，tail 50 → 5 行(55)
  assert.equal(out.split("\n")[4], lines[4], "头部到第 5 行");
  assert.ok(!out.includes(lines[5]));
  assert.ok(out.endsWith(lines.slice(25).join("\n")));
});
