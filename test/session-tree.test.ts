import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionListItem } from "../src/session-list.ts";
import {
  basenameAny,
  buildSessionTree,
  filterAndSortSessions,
  flattenSessionTree,
  fuzzyMatch,
  parseSearchQuery,
} from "../src/session-tree.ts";

let seq = 0;
function makeItem(over: Partial<SessionListItem> & { path: string }): SessionListItem {
  return {
    id: `id-${seq++}`,
    cwd: "/tmp/proj",
    created: new Date("2026-09-14T01:00:00Z"),
    modified: new Date("2026-09-14T01:00:00Z"),
    messageCount: 0,
    firstMessage: "",
    allMessagesText: "",
    mdDir: "/tmp/garden/--s--",
    mdBase: "base",
    ...over,
  };
}

test("basenameAny: 斜杠/反斜杠/裸名", () => {
  assert.equal(basenameAny("/a/b/c.jsonl"), "c.jsonl");
  assert.equal(basenameAny("C:\\Users\\x\\c.jsonl"), "c.jsonl");
  assert.equal(basenameAny("c.jsonl"), "c.jsonl");
});

test("buildSessionTree: fork 配对（basename）/ 孤儿降级 root / 排序按子树最新活跃", () => {
  const a = makeItem({ path: "/s/aaa.jsonl", modified: new Date("2026-09-14T01:00:00Z") });
  const b = makeItem({ path: "/s/bbb.jsonl", parentSessionPath: "/s/aaa.jsonl", modified: new Date("2026-09-14T02:00:00Z") });
  const c = makeItem({ path: "/s/ccc.jsonl", parentSessionPath: "/s/bbb.jsonl", modified: new Date("2026-09-14T03:00:00Z") });
  const orphan = makeItem({
    path: "/s/ddd.jsonl",
    parentSessionPath: "C:\\Users\\x\\deleted-parent.jsonl", // 父不在列表 → root
    modified: new Date("2026-09-14T04:00:00Z"),
  });
  const solo = makeItem({ path: "/s/eee.jsonl", modified: new Date("2026-09-13T01:00:00Z") });

  const roots = buildSessionTree([a, b, c, orphan, solo]);
  assert.equal(roots.length, 3);
  // ddd 最新（04:00）→ 第一；a 的子树最新是 c（03:00）→ 第二；solo 最旧 → 最后
  assert.deepEqual(roots.map((n) => n.session.path), ["/s/ddd.jsonl", "/s/aaa.jsonl", "/s/eee.jsonl"]);
  const aNode = roots[1];
  assert.equal(aNode.children.length, 1);
  assert.equal(aNode.children[0].session.path, "/s/bbb.jsonl");
  assert.equal(aNode.children[0].children[0].session.path, "/s/ccc.jsonl");
  assert.equal(aNode.latestActivity, new Date("2026-09-14T03:00:00Z").getTime(), "latestActivity 冒泡到子树最大");
});

test("buildSessionTree: Windows 风格 parentSession 也能配对；成环不丢节点", () => {
  const parent = makeItem({ path: "/home/u/.pi/agent/sessions/--s--/parent.jsonl" });
  const child = makeItem({
    path: "/s/child.jsonl",
    parentSessionPath: "C:\\Users\\u\\.pi\\agent\\sessions\\--s--\\parent.jsonl", // 跨机器 fork 遗留
  });
  const roots = buildSessionTree([parent, child]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].children[0].session.path, "/s/child.jsonl");

  // 成环（实际数据不可能出现，防御）：两个节点都必须出现在结果里
  const x = makeItem({ path: "/s/x.jsonl", parentSessionPath: "/s/y.jsonl" });
  const y = makeItem({ path: "/s/y.jsonl", parentSessionPath: "/s/x.jsonl" });
  const cycleRoots = buildSessionTree([x, y]);
  const flat = flattenSessionTree(cycleRoots);
  const paths = new Set(flat.map((n) => n.session.path));
  assert.ok(paths.has("/s/x.jsonl") && paths.has("/s/y.jsonl"), "环节点不丢");
});

test("flattenSessionTree: 深度/兄弟/祖先延续线", () => {
  const a = makeItem({ path: "/s/aaa.jsonl" });
  const b = makeItem({ path: "/s/bbb.jsonl", parentSessionPath: "/s/aaa.jsonl" });
  const c = makeItem({ path: "/s/ccc.jsonl", parentSessionPath: "/s/aaa.jsonl" });
  const d = makeItem({ path: "/s/ddd.jsonl", parentSessionPath: "/s/bbb.jsonl" });
  const flat = flattenSessionTree(buildSessionTree([a, b, c, d]));
  assert.equal(flat.length, 4);
  assert.deepEqual(flat.map((n) => [n.session.path, n.depth, n.isLast]), [
    ["/s/aaa.jsonl", 0, true],
    ["/s/bbb.jsonl", 1, false],
    ["/s/ddd.jsonl", 2, true],
    ["/s/ccc.jsonl", 1, true],
  ]);
});

test("parseSearchQuery: 空 / fuzzy / 短语 / 正则 / 引号不配对", () => {
  assert.deepEqual(parseSearchQuery(""), { mode: "tokens", tokens: [] });
  assert.deepEqual(parseSearchQuery("foo bar"), {
    mode: "tokens",
    tokens: [
      { kind: "fuzzy", value: "foo" },
      { kind: "fuzzy", value: "bar" },
    ],
  });
  const phrase = parseSearchQuery('foo "node cve"');
  assert.deepEqual(phrase, {
    mode: "tokens",
    tokens: [
      { kind: "fuzzy", value: "foo" },
      { kind: "phrase", value: "node cve" },
    ],
  });
  const re = parseSearchQuery("re:foo.*bar");
  assert.equal(re.mode, "regex");
  assert.ok(re.mode === "regex" && re.regex?.test("xx foo yy bar"));
  const badRe = parseSearchQuery("re:([");
  assert.ok(badRe.mode === "regex" && badRe.regex === null && badRe.error);
  const unclosed = parseSearchQuery('foo "node cve');
  assert.deepEqual(unclosed, {
    mode: "tokens",
    tokens: [
      { kind: "fuzzy", value: "foo" },
      { kind: "fuzzy", value: '"node' },
      { kind: "fuzzy", value: "cve" },
    ],
  });
});

test("fuzzyMatch: 子序列命中 / 大小写 / 不命中", () => {
  assert.ok(fuzzyMatch("gdn", "garden 开发会话").matches);
  assert.ok(fuzzyMatch("GDN", "garden").matches, "大小写不敏感");
  assert.ok(!fuzzyMatch("zzz", "garden").matches);
});

test("filterAndSortSessions: fuzzy/phrase/regex + 排序（分数升序，同分按活跃）", () => {
  const a = makeItem({
    path: "/s/a.jsonl",
    name: "garden 会话",
    modified: new Date("2026-09-14T01:00:00Z"),
    allMessagesText: "讨论了 node cve 漏洞",
  });
  const b = makeItem({
    path: "/s/b.jsonl",
    name: "无关",
    modified: new Date("2026-09-14T02:00:00Z"),
    allMessagesText: "完全是别的话题",
  });
  assert.deepEqual(filterAndSortSessions([a, b], "garden").map((i) => i.path), ["/s/a.jsonl"]);
  assert.deepEqual(filterAndSortSessions([a, b], '"node cve"').map((i) => i.path), ["/s/a.jsonl"], "精确短语");
  assert.deepEqual(filterAndSortSessions([a, b], '"nodecve"').length, 0, "短语是连续匹配");
  assert.deepEqual(filterAndSortSessions([a, b], "re:漏.*洞").map((i) => i.path), ["/s/a.jsonl"]);
  assert.deepEqual(filterAndSortSessions([a, b], "").length, 2, "空查询原样返回（调用方走树模式）");
  assert.equal(filterAndSortSessions([a, b], "re:([").length, 0, "坏正则匹配零结果");
});
