import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatDateShort, nodeLabel } from "../src/format.ts";
import { buildIndexPage, generateDirIndex, INDEX_FILE_NAME, type IndexFileInfo } from "../src/index-page.ts";
import type { SessionListItem } from "../src/session-list.ts";

// ---------- 测试桩 ----------

/** 用当年日期：formatDateShort 对当年省略年份，断言语义才确定 */
const YEAR = new Date().getFullYear();

let seq = 0;
function makeItem(over: Partial<SessionListItem> & { mdBase: string }): SessionListItem {
  const n = ++seq;
  return {
    path: `/tmp/x/sessions/--p--/${over.mdBase}.jsonl`,
    id: `uuid-${n}`,
    cwd: "/tmp/proj",
    created: new Date(`${YEAR}-09-14T01:00:00Z`),
    modified: new Date(`${YEAR}-09-14T01:00:00Z`),
    messageCount: n,
    firstMessage: `消息${n}`,
    allMessagesText: "",
    mdDir: "/tmp/x/garden/--p--",
    ...over,
  };
}

const stubResolve = (item: SessionListItem): IndexFileInfo => ({ href: `./${item.mdBase}.l3.md`, size: 1024 });

// ---------- format helpers ----------

test("formatDateShort: 同年省略年份，跨年保留完整", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  assert.equal(formatDateShort(new Date("2026-09-14T12:00:00Z"), now), "09-14");
  assert.equal(formatDateShort(new Date("2025-09-14T12:00:00Z"), now), "2025-09-14");
});

test("nodeLabel: 命名超 48 列截断；无名摘要超 36 列截断（均含省略号）", () => {
  const named = makeItem({ mdBase: "a", name: "x".repeat(60) });
  assert.equal(nodeLabel(named), `${"x".repeat(47)}…`);
  const cjk = makeItem({ mdBase: "b", name: "汉".repeat(30) }); // 30 字 = 60 列
  assert.equal(nodeLabel(cjk), `${"汉".repeat(23)}…`); // 23*2 + 1(…) = 47 ≤ 48
  const unnamed = makeItem({ mdBase: "c", name: undefined, firstMessage: "y".repeat(60) });
  assert.equal(nodeLabel(unnamed), `"${"y".repeat(35)}…"`);
  const short = makeItem({ mdBase: "d", name: "短名" });
  assert.equal(nodeLabel(short), "短名");
});

// ---------- buildIndexPage ----------

test("buildIndexPage: 头部统计 + fork 森林嵌套列表 + emoji + 元数据 chip", () => {
  const root = makeItem({ mdBase: "2026-09-14-001-根", name: "根会话", messageCount: 100, modified: new Date(`${YEAR}-09-14T01:00:00Z`) });
  const child = makeItem({
    mdBase: "2026-09-15-001-子",
    name: "子会话",
    messageCount: 50,
    modified: new Date(`${YEAR}-09-15T01:00:00Z`),
    parentSessionPath: `/tmp/x/sessions/--p--/${root.mdBase}.jsonl`,
  });
  // 另一棵树：整体更新（应排前面）
  const other = makeItem({ mdBase: "2026-09-16-001-另", name: "另一棵", messageCount: 10, modified: new Date(`${YEAR}-09-16T01:00:00Z`) });
  const text = buildIndexPage([root, child, other], stubResolve);
  const lines = text.split("\n");

  assert.equal(lines[0], "# 🌳 会话索引 — proj");
  assert.equal(lines[2], "> `3 条对话 · 2 棵会话树 · 3KB 总计` · 项目 `/tmp/proj`");
  // 说明块藏在 HTML 注释（渲染不可见）
  assert.ok(lines[4] === "<!--" && lines.includes("-->"), "说明块在 HTML 注释里");
  // 最近活跃的树（另一棵）排最前
  const iOther = lines.findIndex((l) => l.includes("[另一棵]"));
  const iRoot = lines.findIndex((l) => l.includes("[根会话]"));
  const iChild = lines.findIndex((l) => l.includes("[子会话]"));
  assert.ok(iOther > 0 && iRoot > iOther && iChild > iRoot, `顺序: other=${iOther} root=${iRoot} child=${iChild}`);
  // 💬 根 / 🌿 fork；元数据反引号 chip；当年日期 MM-DD
  assert.equal(lines[iOther], "- 💬 [另一棵](<./2026-09-16-001-另.l3.md>) `10 msgs · 1KB · 09-16`");
  assert.match(lines[iRoot], /^- 💬 \[根会话\]\(<\.\//);
  assert.match(lines[iChild], /^ {2}- 🌿 \[子会话\]\(<\.\/2026-09-15-001-子\.l3\.md>\) `50 msgs · 1KB · 09-15`$/);
  // 两棵树之间有空行
  assert.equal(lines[iRoot - 1], "");
});

test("buildIndexPage: 无名会话回退首条消息摘要（加引号）；无消息 → untitled", () => {
  const unnamed = makeItem({ mdBase: "2026-09-14-001-a", name: undefined, firstMessage: "帮我看看这个 bug" });
  const empty = makeItem({ mdBase: "2026-09-14-002-b", name: undefined, firstMessage: "" });
  const text = buildIndexPage([unnamed, empty], stubResolve);
  assert.ok(text.includes('["帮我看看这个 bug"]'), "摘要加引号");
  assert.ok(text.includes("[untitled]"), "无消息兜底 untitled");
});

test("buildIndexPage: 链接 label 转义方括号；size null → ?", () => {
  const item = makeItem({ mdBase: "2026-09-14-001-a", name: "fix [WIP] 分支" });
  const text = buildIndexPage([item], () => ({ href: "./x.l1.md", size: null }));
  assert.ok(text.includes("[fix \\[WIP\\] 分支](<./x.l1.md>)"), text);
  assert.ok(text.includes("· ? ·"), "size null 显示 ?");
});

test("buildIndexPage: 无 cwd → 标题与统计行无项目后缀", () => {
  const item = makeItem({ mdBase: "2026-09-14-001-a", cwd: "" });
  const text = buildIndexPage([item], stubResolve);
  assert.ok(text.startsWith("# 🌳 会话索引\n"), text.split("\n")[0]);
  assert.equal(text.split("\n")[2], "> `1 条对话 · 1 棵会话树 · 1KB 总计`");
});

// ---------- generateDirIndex（真实文件系统 fixture） ----------

function mdFixture(fm: { id: string; name?: string; cwd?: string; source: string; parent?: string; ended?: string }): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = ["---", `level: ${q("l3")}`, `session_id: ${q(fm.id)}`];
  if (fm.cwd) lines.push(`cwd: ${q(fm.cwd)}`);
  if (fm.parent) lines.push(`parent_session: ${q(fm.parent)}`);
  lines.push(`started: ${q(`${YEAR}-09-14T01:00:00.000Z`)}`, `ended: ${q(fm.ended ?? `${YEAR}-09-14T02:00:00.000Z`)}`);
  if (fm.name) lines.push(`name: ${q(fm.name)}`);
  lines.push("messages:", "  user: 2", "  assistant: 2", `source: ${q(fm.source)}`, "---", "", "## 🙋 User · 09-14 09:00", "", "你好", "");
  return lines.join("\n");
}

test("generateDirIndex: 从 md 产物生成 index.md；重复生成 changed=false；空目录 → null", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garden-index-"));
  const dir = path.join(tmp, "garden", "--tmp-proj--");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-09-14-001-根.l3.md"), mdFixture({ id: "uuid-root", name: "根会话", cwd: "/tmp/proj", source: "root.jsonl" }));
  fs.writeFileSync(
    path.join(dir, "2026-09-15-001-子.l3.md"),
    mdFixture({ id: "uuid-child", name: "子会话", cwd: "/tmp/proj", source: "child.jsonl", parent: "/tmp/x/sessions/--tmp-proj--/root.jsonl", ended: `${YEAR}-09-15T02:00:00.000Z` }),
  );

  const r = await generateDirIndex(dir);
  assert.ok(r, "有产物应生成");
  assert.equal(r.sessions, 2);
  assert.equal(r.roots, 1);
  assert.equal(r.changed, true);
  assert.equal(path.basename(r.file), INDEX_FILE_NAME);

  const content = fs.readFileSync(r.file, "utf-8");
  assert.ok(content.includes("# 🌳 会话索引 — proj"), "标题含项目名");
  assert.ok(content.includes("`2 条对话 · 1 棵会话树"), "统计 chip");
  assert.ok(content.includes("- 💬 [根会话](<./2026-09-14-001-根.l3.md>)"), "根行相对链接");
  assert.ok(content.includes("\n  - 🌿 [子会话](<./2026-09-15-001-子.l3.md>)"), "子行缩进");
  assert.ok(content.includes("4 msgs"), "messages 各 role 求和");

  // 重复生成：内容不变 → changed=false，mtime 不动
  const mtime1 = fs.statSync(r.file).mtimeMs;
  const r2 = await generateDirIndex(dir);
  assert.equal(r2?.changed, false);
  assert.equal(fs.statSync(r.file).mtimeMs, mtime1);

  // 空目录 → null，不写文件
  const emptyDir = path.join(tmp, "garden", "--empty--");
  fs.mkdirSync(emptyDir, { recursive: true });
  assert.equal(await generateDirIndex(emptyDir), null);
  assert.ok(!fs.existsSync(path.join(emptyDir, INDEX_FILE_NAME)));

  // index.md 自身不会被当作会话产物（再生成仍是 2 条）
  const r3 = await generateDirIndex(dir);
  assert.equal(r3?.sessions, 2);

  fs.rmSync(tmp, { recursive: true, force: true });
});
