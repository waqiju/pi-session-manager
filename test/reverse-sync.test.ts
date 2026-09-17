import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ARCHIVE_DIR_NAME,
  archiveSessionFile,
  parseIndexRows,
  planPreview,
  planReverseSync,
  rewriteSessionParent,
} from "../src/reverse-sync.ts";
import type { SessionListItem } from "../src/session-list.ts";

// ---------- 测试桩 ----------

let seq = 0;
function makeItem(over: Partial<SessionListItem> & { mdBase: string }): SessionListItem {
  const n = ++seq;
  return {
    path: `/tmp/x/sessions/--p--/${over.mdBase}.jsonl`,
    id: `uuid-${n}`,
    cwd: "/tmp/proj",
    created: new Date("2026-09-14T01:00:00Z"),
    modified: new Date("2026-09-14T01:00:00Z"),
    messageCount: n,
    firstMessage: `消息${n}`,
    allMessagesText: "",
    mdDir: "/tmp/x/garden/--p--",
    ...over,
  };
}

const GS = " ".repeat(2); // figure spaces，与生成的 index.md 一致

function row(depth: number, name: string, base: string, marker?: string): string {
  return `${"  ".repeat(depth)}- 📄 [${name}](<./${base}.l3.md>)${GS}\`10 msgs · 09-16\`${marker ? ` ${marker}` : ""}`;
}

/** 造一个真实 jsonl（header + 两条 entry） */
function writeJsonl(file: string, header: Record<string, unknown>): void {
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: "model_change", id: "aaaa", parentId: null, timestamp: "2026-09-14T01:00:00Z", provider: "p", modelId: "m" }),
    JSON.stringify({ type: "session_info", id: "bbbb", parentId: "aaaa", timestamp: "2026-09-14T01:00:01Z", name: "x" }),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "garden-reverse-sync-"));
}

// ---------- parseIndexRows ----------

test("parseIndexRows: 缩进/图标/href/标记解析；非条目行跳过", () => {
  const text = [
    "# 🌳 会话索引 — proj",
    "",
    "<!--",
    "说明注释",
    "-->",
    "",
    row(0, "根会话", "2026-09-14-001-根"),
    row(1, "子会话", "2026-09-15-001-子", "to-delete"),
    `  - 📄 [归档我](<./2026-09-15-002-归.l1.md>)${GS}\`3 msgs · 09-15\`  to-archive  `,
    row(0, "另一棵", "2026-09-16-001-另"),
  ].join("\n");
  const rows = parseIndexRows(text);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => [r.depth, r.mdBase, r.marker]),
    [
      [0, "2026-09-14-001-根", null],
      [1, "2026-09-15-001-子", "to-delete"],
      [1, "2026-09-15-002-归", "to-archive"],
      [0, "2026-09-16-001-另", null],
    ],
  );
  assert.equal(rows[1].line, 8);
});

test("parseIndexRows: 严格性——大写标记/标记不在行尾/无元数据 chip 的行不解析", () => {
  const good = row(0, "好", "2026-09-14-001-好");
  const cases = [
    row(0, "大写", "2026-09-14-002-大写", "To-Delete"), // 必须小写
    `- 📄 [标记不在尾](<./2026-09-14-003-x.l3.md>) to-delete${GS}\`1 msgs · 09-16\``,
    `- 📄 [无chip](<./2026-09-14-004-y.l3.md>) to-delete`,
  ];
  for (const bad of cases) {
    assert.deepEqual(parseIndexRows(`${good}\n${bad}`).length, 1, `应跳过: ${bad}`);
  }
  // 名为 to-delete 的会话（label 含标记词）不受影响
  const named = row(0, "to-delete", "2026-09-10-005-to-delete");
  const rows = parseIndexRows(named);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].marker, null);
  // 标记与 chip 粘连（无空格）也认
  const sticky = parseIndexRows(`- 📄 [粘连](<./2026-09-14-005-z.l3.md>)${GS}\`1 msgs · 09-16\`to-delete`);
  assert.equal(sticky[0]?.marker, "to-delete");
});

// ---------- planReverseSync ----------

test("planReverseSync: 无编辑 → 零操作；换父/提根生成 reparent", () => {
  const root = makeItem({ mdBase: "r", name: "根" });
  const child = makeItem({ mdBase: "c", name: "子", parentSessionPath: root.path });
  const other = makeItem({ mdBase: "o", name: "另" });

  // 原样：无操作
  const same = planReverseSync([rowsFrom(0, "r"), rowsFrom(1, "c"), rowsFrom(0, "o")], [root, child, other]);
  assert.ok(same.ok);
  assert.deepEqual(planPreview(same.plan), { reparents: 0, deletes: 0, archives: 0, detached: 0 });

  // 把 c 挪到 o 下面 → reparent 到 o.path
  const moved = planReverseSync([rowsFrom(0, "r"), rowsFrom(0, "o"), rowsFrom(1, "c")], [root, child, other]);
  assert.ok(moved.ok);
  assert.deepEqual(moved.plan.reparents, [{ item: child, newParentPath: other.path }]);

  // 把 c 提为根 → newParentPath null
  const rooted = planReverseSync([rowsFrom(0, "r"), rowsFrom(0, "c"), rowsFrom(0, "o")], [root, child, other]);
  assert.ok(rooted.ok);
  assert.deepEqual(rooted.plan.reparents, [{ item: child, newParentPath: null }]);
});

test("planReverseSync: to-delete / to-archive / 父删子脱钩为根", () => {
  const root = makeItem({ mdBase: "r", name: "PSM" });
  const child = makeItem({ mdBase: "c", name: "index.md", parentSessionPath: root.path });
  const keep = makeItem({ mdBase: "k", name: "保留" });

  const r = planReverseSync(
    [rowsFrom(0, "r", "to-archive"), rowsFrom(1, "c"), rowsFrom(0, "k")],
    [root, child, keep],
  );
  assert.ok(r.ok);
  assert.deepEqual(r.plan.deletes, []);
  assert.equal(r.plan.archives.length, 1);
  assert.equal(r.plan.archives[0].item, root);
  assert.equal(r.plan.archives[0].treePath, "PSM");
  // child 的父被归档 → 脱钩为根（显式置 null）
  assert.equal(r.plan.detached, 1);
  assert.deepEqual(r.plan.reparents, [{ item: child, newParentPath: null }]);
});

test("planReverseSync: 归档 treePath 拼接根到自身的名称路径", () => {
  const a = makeItem({ mdBase: "a", name: "PSM" });
  const b = makeItem({ mdBase: "b", name: "pi-集成", parentSessionPath: a.path });
  const c = makeItem({ mdBase: "c", name: "copy-subtree", parentSessionPath: b.path });
  const r = planReverseSync(
    [rowsFrom(0, "a"), rowsFrom(1, "b"), rowsFrom(2, "c", "to-archive")],
    [a, b, c],
  );
  assert.ok(r.ok);
  assert.equal(r.plan.archives[0].treePath, "PSM / pi-集成 / copy-subtree");
});

/** plan 失败路径：取出 error 文案 */
function planError(rows: ReturnType<typeof rowsFrom>[], items: SessionListItem[], opts?: { protectedPaths?: ReadonlySet<string> }): string {
  const r = planReverseSync(rows, items, opts);
  assert.ok(!r.ok);
  return r.error;
}

test("planReverseSync: 对账失败——未知链接 / 重复 / 缺失 / 缩进跳跃 / 空文件", () => {
  const a = makeItem({ mdBase: "a", name: "甲" });
  const b = makeItem({ mdBase: "b", name: "乙" });

  assert.match(planError([rowsFrom(0, "a"), rowsFrom(0, "ghost")], [a, b]), /无法匹配任何会话/);
  assert.match(planError([rowsFrom(0, "a"), rowsFrom(1, "a")], [a, b]), /重复出现/);
  assert.match(planError([rowsFrom(0, "a")], [a, b]), /缺少 1 条.*乙/);
  assert.match(planError([rowsFrom(0, "a"), rowsFrom(2, "b")], [a, b]), /缩进跳跃/);
  assert.match(planError([], [a, b]), /未解析到任何会话条目/);
});

test("planReverseSync: 当前活跃 session 禁止删除/归档", () => {
  const cur = makeItem({ mdBase: "cur", name: "当前" });
  const a = makeItem({ mdBase: "a", name: "甲" });
  const opts = { protectedPaths: new Set([cur.path]) };
  assert.match(planError([rowsFrom(0, "cur", "to-delete"), rowsFrom(0, "a")], [cur, a], opts), /不能删除当前活跃 session/);
  assert.match(planError([rowsFrom(0, "cur", "to-archive"), rowsFrom(0, "a")], [cur, a], opts), /不能归档当前活跃 session/);
  // 换父不受限
  const r = planReverseSync([rowsFrom(0, "a"), rowsFrom(1, "cur")], [cur, a], opts);
  assert.ok(r.ok);
  assert.deepEqual(r.plan.reparents, [{ item: cur, newParentPath: a.path }]);
});

/** 测试用行构造（绕过文本解析，直接给 plan 用） */
function rowsFrom(depth: number, mdBase: string, marker: "to-delete" | "to-archive" | null = null) {
  return { depth, mdBase, marker, line: 0 };
}

// ---------- rewriteSessionParent ----------

test("rewriteSessionParent: 换父/提根；id 不符拒改；正文不动", () => {
  const dir = tmpdir();
  const file = path.join(dir, "s.jsonl");
  writeJsonl(file, { type: "session", version: 3, id: "uuid-1", timestamp: "t", cwd: "/tmp/proj", parentSession: "/old/parent.jsonl" });

  // 换父
  const r1 = rewriteSessionParent(file, "uuid-1", "/new/parent.jsonl");
  assert.ok(r1.ok);
  let header = JSON.parse(fs.readFileSync(file, "utf-8").split("\n")[0]);
  assert.equal(header.parentSession, "/new/parent.jsonl");
  assert.equal(header.id, "uuid-1");

  // 提根（删字段）
  const r2 = rewriteSessionParent(file, "uuid-1", null);
  assert.ok(r2.ok);
  header = JSON.parse(fs.readFileSync(file, "utf-8").split("\n")[0]);
  assert.ok(!("parentSession" in header));

  // 正文 entry 未被触碰
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  assert.equal(lines.length, 4); // header + 2 entries + 结尾换行
  assert.equal(JSON.parse(lines[1]).type, "model_change");
  assert.equal(JSON.parse(lines[2]).type, "session_info");

  // id 不符 → 拒改
  const r3 = rewriteSessionParent(file, "uuid-OTHER", "/x.jsonl");
  assert.ok(!r3.ok);
  assert.match(r3.error!, /id 不一致/);

  // 文件不存在
  assert.ok(!rewriteSessionParent(path.join(dir, "nope.jsonl"), "uuid-1", null).ok);
});

test("rewriteSessionParent: 无换行结尾的单行文件也能改", () => {
  const dir = tmpdir();
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "uuid-9", timestamp: "t", cwd: "/p" }));
  const r = rewriteSessionParent(file, "uuid-9", "/p/parent.jsonl");
  assert.ok(r.ok);
  const text = fs.readFileSync(file, "utf-8");
  assert.equal(JSON.parse(text.split("\n")[0]).parentSession, "/p/parent.jsonl");
  assert.ok(text.endsWith("\n"));
});

// ---------- archiveSessionFile ----------

test("archiveSessionFile: header 加归档字段 + 挪入 1_archived；pi 仍可按原格式解析", () => {
  const dir = tmpdir();
  const file = path.join(dir, "s.jsonl");
  writeJsonl(file, { type: "session", version: 3, id: "uuid-2", timestamp: "t", cwd: "/tmp/proj", parentSession: "/p.jsonl" });

  const now = new Date("2026-09-17T08:00:00Z");
  const r = archiveSessionFile(file, "uuid-2", "PSM / index.md", now);
  assert.ok(r.ok);
  assert.equal(r.archivedPath, path.join(dir, ARCHIVE_DIR_NAME, "s.jsonl"));
  assert.ok(!fs.existsSync(file), "原路径已挪走");
  const header = JSON.parse(fs.readFileSync(r.archivedPath!, "utf-8").split("\n")[0]);
  assert.equal(header.type, "session");
  assert.equal(header.id, "uuid-2");
  assert.equal(header.parentSession, "/p.jsonl", "原 parent 保留");
  assert.equal(header.archivedTreePath, "PSM / index.md");
  assert.equal(header.archivedAt, "2026-09-17T08:00:00.000Z");

  // 目标已存在 → 拒绝且不重复写
  const r2 = archiveSessionFile(path.join(dir, "s.jsonl"), "uuid-2", "x");
  assert.ok(!r2.ok);
  // 源不存在
  assert.ok(!archiveSessionFile(path.join(dir, "ghost.jsonl"), "uuid-2", "x").ok);
});
