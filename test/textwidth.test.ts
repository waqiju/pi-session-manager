import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi, truncateToWidth, visibleWidth } from "../src/textwidth.ts";

test("visibleWidth: ASCII / CJK 宽字符 / ANSI 序列零宽", () => {
  assert.equal(visibleWidth("hello"), 5);
  assert.equal(visibleWidth("开发"), 4);
  assert.equal(visibleWidth("a开发b"), 6);
  assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(visibleWidth("\x1b_pi:c\x07abc"), 3, "CURSOR_MARKER 零宽");
  assert.equal(stripAnsi("\x1b[1mbold\x1b[0m"), "bold");
});

test("truncateToWidth: 不超宽原样 / 超宽加省略号 / 不劈宽字符 / 保留 ANSI", () => {
  assert.equal(truncateToWidth("hello", 10), "hello");
  assert.equal(truncateToWidth("hello world", 8), "hello w…");
  // 宽字符边界：预算 7 → 省略号占 1，剩 6 → "a" + "开发"(4) = 5，再放 "b"=6；放 "c" 会 7 超？逐步验证
  const t = truncateToWidth("a开发bcdef", 7);
  assert.equal(visibleWidth(t), 7);
  assert.ok(t.endsWith("…"));
  // ANSI 序列保留且不计宽
  const ansi = truncateToWidth("\x1b[31mhello world\x1b[0m", 8);
  assert.ok(ansi.includes("\x1b[31m"));
  assert.equal(visibleWidth(ansi), 8);
});
