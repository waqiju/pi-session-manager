import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildGardenIndex,
  collectSessionFiles,
  collectSessionSubdirs,
  enrichFromGarden,
  gardenDirForSessionDir,
  listAllSessions,
  listProjectSessions,
  parseGardenFrontmatter,
  readSessionHead,
  type SessionListItem,
} from "../src/session-list.ts";
import { buildSampleJsonl, USER_PROMPT_1 } from "./sample.ts";

function setup(): { root: string; sessionsDir: string; fileA: string; fileB: string } {
  const root = mkdtempSync(path.join(tmpdir(), "garden-list-test-"));
  const sessionsDir = path.join(root, "sessions");
  const sub = path.join(sessionsDir, "--tmp-proj--");
  mkdirSync(sub, { recursive: true });
  const fileA = path.join(sub, "2026-09-14T01-00-00_aaaa.jsonl");
  writeFileSync(fileA, buildSampleJsonl());
  const headerB = {
    type: "session",
    version: 3,
    id: "bbbb",
    timestamp: "2026-09-14T02:00:00.000Z",
    cwd: "/tmp/proj",
    parentSession: fileA,
  };
  const fileB = path.join(sub, "2026-09-14T02-00-00_bbbb.jsonl");
  writeFileSync(fileB, JSON.stringify(headerB) + "\n");
  return { root, sessionsDir, fileA, fileB };
}

test("readSessionHead: 解析 header / 首条 user 消息 / 缓冲内 session_info 名", async () => {
  const { root, fileA, fileB } = setup();
  try {
    const a = await readSessionHead(fileA);
    assert.equal(a?.id, "test-session-uuid");
    assert.equal(a?.cwd, "/tmp/proj");
    assert.equal(a?.parentSessionPath, undefined);
    assert.equal(a?.firstMessage, USER_PROMPT_1);
    assert.equal(a?.name, "garden 开发会话");

    const b = await readSessionHead(fileB);
    assert.equal(b?.parentSessionPath, fileA, "fork 继承链来自 header.parentSession");

    assert.equal(await readSessionHead(path.join(root, "nonexistent.jsonl")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSessionHead: 首行非 session header → null", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-list-test-"));
  try {
    const bad = path.join(root, "bad.jsonl");
    writeFileSync(bad, JSON.stringify({ type: "message", id: "x" }) + "\n");
    assert.equal(await readSessionHead(bad), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSessionFiles / collectSessionSubdirs: 一层、跳过隐藏项", async () => {
  const { root, sessionsDir } = setup();
  try {
    writeFileSync(path.join(sessionsDir, "--tmp-proj--", "not-a-session.txt"), "x");
    writeFileSync(path.join(sessionsDir, "--tmp-proj--", ".hidden.jsonl"), "x");
    mkdirSync(path.join(sessionsDir, ".mono"));
    const files = await collectSessionFiles(path.join(sessionsDir, "--tmp-proj--"));
    assert.equal(files.length, 2);
    const subs = await collectSessionSubdirs(sessionsDir);
    assert.deepEqual(subs.map((s) => path.basename(s)), ["--tmp-proj--"]);
    assert.deepEqual(await collectSessionFiles(path.join(root, "nope")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseGardenFrontmatter: name + messageCount 求和；坏输入容忍", () => {
  const fm = parseGardenFrontmatter(
    [
      "---",
      'level: "l2"',
      'session_id: "x"',
      'name: "我的 \\"会话\\" 名"',
      "messages:",
      "  user: 3",
      "  assistant: 5",
      "  toolResult: 4",
      "tokens:",
      "  input: 10",
      "---",
      "正文",
    ].join("\n"),
  );
  assert.equal(fm.name, '我的 "会话" 名');
  assert.equal(fm.messageCount, 12);

  assert.deepEqual(parseGardenFrontmatter("no frontmatter"), {});
  assert.deepEqual(parseGardenFrontmatter("---\nname: not-json\n---\n"), {});
});

test("listProjectSessions: 快速列表 + garden frontmatter 富化", async () => {
  const { root, sessionsDir, fileA } = setup();
  try {
    const sessionDir = path.join(sessionsDir, "--tmp-proj--");
    // garden 输出目录按标准布局推导：<root>/garden/<sub>
    const gardenDir = gardenDirForSessionDir(sessionDir);
    assert.equal(gardenDir, path.join(root, "garden", "--tmp-proj--"));
    mkdirSync(gardenDir, { recursive: true });
    // 新命名输出：文件名与 jsonl 无推导关系，索引靠 frontmatter session_id
    writeFileSync(
      path.join(gardenDir, "2026-09-14-001-富化名.l2.md"),
      "---\n" + 'session_id: "test-session-uuid"\n' + 'name: "富化来的名字"\n' + "messages:\n  user: 10\n  assistant: 20\n---\n\n正文语料\n",
    );

    const progress: [number, number][] = [];
    const items = await listProjectSessions(sessionDir, { onProgress: (l, t) => progress.push([l, t]) });
    assert.equal(items.length, 2);
    assert.equal(progress.at(-1)?.[1], 2);

    const a = items.find((i) => i.path === fileA)!;
    assert.equal(a.name, "garden 开发会话", "头部缓冲内已有 name，富化不覆盖");
    assert.equal(a.messageCount, 30, "messageCount 从 frontmatter 富化");
    assert.equal(a.firstMessage, USER_PROMPT_1);
    assert.ok(a.created instanceof Date && a.modified instanceof Date);

    const b = items.find((i) => i.id === "bbbb")!;
    assert.equal(b.parentSessionPath, fileA);
    assert.equal(b.messageCount, 0, "无 garden 产物 → 保持 0");
    assert.equal(b.firstMessage, "(no messages)", "对齐内建显示兜底");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enrichFromGarden: 无产物时 item 不变；仅 l0/l1 旧产物不富化（索引只认 l2）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-list-test-"));
  try {
    const item: SessionListItem = {
      path: "/x/sessions/--s--/a.jsonl",
      id: "a",
      cwd: "/x",
      created: new Date(0),
      modified: new Date(0),
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
    };
    await enrichFromGarden(item, await buildGardenIndex(path.join(root, "garden", "--s--"))); // 不存在
    assert.equal(item.messageCount, 0);

    const dir = path.join(root, "garden", "--s--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a.l0.md"), "---\nsession_id: \"a\"\nmessages:\n  user: 2\n  toolResult: 3\n---\n");
    await enrichFromGarden(item, await buildGardenIndex(dir));
    assert.equal(item.messageCount, 0, "旧版 l0-only 产物不再参与富化");
    assert.equal(item.name, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enrichFromGarden: fullText 默认开，l2 正文回填 allMessagesText（剥 frontmatter）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-list-test-"));
  try {
    const dir = path.join(root, "garden", "--s--");
    mkdirSync(dir, { recursive: true });
    const mkItem = (): SessionListItem => ({
      path: "/x/sessions/--s--/a.jsonl",
      id: "a",
      cwd: "/x",
      created: new Date(0),
      modified: new Date(0),
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
    });
    // 新命名：文件名与 jsonl 无推导关系，靠 frontmatter session_id 反查
    writeFileSync(
      path.join(dir, "2026-09-14-001-起名了.l2.md"),
      "---\nsession_id: \"a\"\nmessages:\n  user: 2\n  assistant: 3\n---\n\n## 🙋 User · #1\n\n搜我这句话\n\n## ✨ Assistant\n\n答复文本\n",
    );
    // 同 session 的旧命名残留：索引应优先新命名
    writeFileSync(path.join(dir, "2026-09-14T01-00-00_aaaa.l2.md"), "---\nsession_id: \"a\"\n---\n\n旧正文不应被读到\n");
    // 别的 session 的文件不影响
    writeFileSync(path.join(dir, "2026-09-14-002-别的.l2.md"), "---\nsession_id: \"b\"\n---\n\n他人正文\n");

    const index = await buildGardenIndex(dir);
    assert.equal(index.get("a")?.name, "2026-09-14-001-起名了.l2.md", "冲突时新命名优先");

    const item = mkItem();
    await enrichFromGarden(item, index);
    assert.equal(item.messageCount, 5);
    assert.ok(item.allMessagesText.includes("搜我这句话"), "l2 正文成为搜索语料");
    assert.ok(!item.allMessagesText.includes("messages:"), "frontmatter 已剥离");
    assert.ok(!item.allMessagesText.includes("旧正文"), "读到的是新命名那份");

    // fullText:false → 只取 frontmatter，不读正文
    const item3 = mkItem();
    await enrichFromGarden(item3, index, { fullText: false });
    assert.equal(item3.messageCount, 5);
    assert.equal(item3.allMessagesText, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSessionSubdirs: 纳入 symlink 目录（对齐内建 listAll），仍跳过隐藏目录", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-list-test-"));
  try {
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(path.join(sessionsDir, "--real--"), { recursive: true });
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(elsewhere, path.join(sessionsDir, "--linked--"));
    mkdirSync(path.join(sessionsDir, ".mono"));
    const subs = await collectSessionSubdirs(sessionsDir);
    assert.deepEqual(subs.map((s) => path.basename(s)), ["--linked--", "--real--"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listAllSessions: 跨子目录聚合", async () => {
  const { root, sessionsDir } = setup();
  try {
    const sub2 = path.join(sessionsDir, "--tmp-other--");
    mkdirSync(sub2);
    const header = { type: "session", version: 3, id: "cccc", timestamp: "2026-09-14T03:00:00.000Z", cwd: "/tmp/other" };
    writeFileSync(path.join(sub2, "2026-09-14T03-00-00_cccc.jsonl"), JSON.stringify(header) + "\n");
    const items = await listAllSessions(sessionsDir, { gardenDir: undefined });
    assert.equal(items.length, 3);
    assert.ok(items.some((i) => i.id === "cccc"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
