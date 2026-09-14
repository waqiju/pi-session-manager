import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractNamingInfo,
  localDate,
  planBaseNames,
  slugifyName,
  SLUG_MAX_CHARS,
  UNTITLED,
} from "../src/naming.ts";
import type { NamingInfo } from "../src/naming.ts";
import type { Entry, SessionHeader } from "../src/types.ts";

// ---------- slugifyName ----------

test("slugifyName: 无名称 → untitled", () => {
  assert.equal(slugifyName(null), UNTITLED);
  assert.equal(slugifyName(undefined), UNTITLED);
  assert.equal(slugifyName(""), UNTITLED);
  assert.equal(slugifyName("   "), UNTITLED);
  assert.equal(slugifyName("..."), UNTITLED); // 尾部点全去掉后为空
});

test("slugifyName: 空白与非法字符 → _，CJK 原样保留", () => {
  assert.equal(slugifyName("禁用进程-CPU占用高"), "禁用进程-CPU占用高");
  assert.equal(slugifyName("garden 开发会话"), "garden_开发会话");
  assert.equal(slugifyName("a  b\tc\nd"), "a_b_c_d");
  assert.equal(slugifyName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(slugifyName("  fix bug  "), "fix_bug");
  assert.equal(slugifyName("a.b"), "a.b"); // 中间的点保留
});

test("slugifyName: 超长截断到 40 个 code point，不劈开代理对", () => {
  assert.equal(slugifyName("汉".repeat(50)).length, SLUG_MAX_CHARS);
  const s = slugifyName("🙂".repeat(50));
  assert.equal(Array.from(s).length, SLUG_MAX_CHARS);
  assert.equal(s, "🙂".repeat(SLUG_MAX_CHARS)); // 没有半个代理对
});

// ---------- localDate ----------

test("localDate: 与本地时区换算一致，格式 YYYY-MM-DD", () => {
  const iso = "2026-09-14T01:00:00.000Z";
  const d = new Date(iso);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(localDate(iso), expected);
  assert.match(localDate(iso), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------- extractNamingInfo ----------

test("extractNamingInfo: 取最后一条 session_info 名（last wins）", () => {
  const header = { type: "session", version: 3, id: "uuid-1", timestamp: "2026-09-14T01:00:00.000Z", cwd: "/x" } as SessionHeader;
  const entries = [
    { type: "session_info", id: "e1", parentId: null, timestamp: "2026-09-14T01:01:00.000Z", name: "旧名" },
    { type: "session_info", id: "e2", parentId: null, timestamp: "2026-09-14T01:02:00.000Z", name: "新名" },
  ] as unknown as Entry[];
  const r = extractNamingInfo("/s/2026-09-14T01-00-00_x.jsonl", header, entries, 0);
  assert.equal(r.name, "新名");
  assert.equal(r.id, "uuid-1");
  assert.equal(r.timestamp, "2026-09-14T01:00:00.000Z");
});

test("extractNamingInfo: timestamp 兜底链 header → 文件名前缀 → mtime", () => {
  const fromName = extractNamingInfo("/s/2026-09-14T01-02-03-456Z_abc.jsonl", null, [], 0);
  assert.equal(fromName.timestamp, "2026-09-14T01:02:03.456Z");
  assert.equal(fromName.id, "2026-09-14T01-02-03-456Z_abc"); // 无 header 时 id 兜底为文件名

  const mtime = Date.parse("2026-01-02T03:04:05.000Z");
  const fromMtime = extractNamingInfo("/s/plain.jsonl", null, [], mtime);
  assert.equal(fromMtime.timestamp, "2026-01-02T03:04:05.000Z");
});

// ---------- planBaseNames ----------

function info(src: string, timestamp: string, name: string | null = null, id = src): NamingInfo {
  return { src, id, timestamp, name };
}

test("planBaseNames: 同日按时间升序编号，跨日期各自从 001 起", () => {
  // 正午 UTC：±12h 内任意真实时区都落在同一本地日期
  const d14 = localDate("2026-09-14T12:00:00.000Z");
  const d20 = localDate("2026-09-20T12:00:00.000Z");
  assert.notEqual(d14, d20);
  const bases = planBaseNames([
    info("b", "2026-09-14T12:20:00.000Z", "beta"),
    info("a", "2026-09-14T12:10:00.000Z", "alpha"), // 乱序输入
    info("c", "2026-09-20T12:10:00.000Z", "gamma"),
  ]);
  assert.equal(bases.get("a"), `${d14}-001-alpha`);
  assert.equal(bases.get("b"), `${d14}-002-beta`);
  assert.equal(bases.get("c"), `${d20}-001-gamma`);
});

test("planBaseNames: 无名称 → untitled；slug 应用命名规则", () => {
  const d = localDate("2026-09-14T12:00:00.000Z");
  const bases = planBaseNames([
    info("a", "2026-09-14T12:00:00.000Z"),
    info("b", "2026-09-14T12:10:00.000Z", "my session"),
  ]);
  assert.equal(bases.get("a"), `${d}-001-${UNTITLED}`);
  assert.equal(bases.get("b"), `${d}-002-my_session`);
});

test("planBaseNames: 时间戳相同按 id 排序，结果确定", () => {
  const ts = "2026-09-14T12:00:00.000Z";
  const bases = planBaseNames([info("src-b", ts, "x", "id-b"), info("src-a", ts, "x", "id-a")]);
  const d = localDate(ts);
  assert.equal(bases.get("src-a"), `${d}-001-x`);
  assert.equal(bases.get("src-b"), `${d}-002-x`);
});
