import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectMdFiles,
  collectSubdirs,
  extractFirstUserMessage,
  gardenDirForSessionDir,
  gardenRootForSessionDir,
  listAllSessions,
  listProjectSessions,
  parseGardenFrontmatter,
  stripFrontmatter,
} from "../src/session-list.ts";

/** 构造 garden md 文本（frontmatter + 正文） */
function buildMd(fm: Record<string, string | undefined>, body = ""): string {
  const lines = ["---", 'level: "l2"'];
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined) lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n" + body;
}

const USER_BODY = "\n## 🙋 User · #1 · 01:00:05\n\n请读取 package.json 并总结\n\n## ✨ Assistant · 01:00:06\n\n好的。\n";

/** tmp 下搭 pi 标准布局：sessions/<sub>/（空）+ garden/<sub>/*.md */
function setup(): { root: string; gardenDir: string; sub: string } {
  const root = mkdtempSync(path.join(tmpdir(), "garden-list-test-"));
  const sub = "--tmp-proj--";
  const gardenDir = path.join(root, "garden", sub);
  mkdirSync(gardenDir, { recursive: true });
  mkdirSync(path.join(root, "sessions", sub), { recursive: true });
  return { root, gardenDir, sub };
}

test("parseGardenFrontmatter: 全字段 + 坏输入容忍", () => {
  const fm = parseGardenFrontmatter(
    [
      "---",
      'level: "l2"',
      'session_id: "abc-uuid"',
      'cwd: "/tmp/proj"',
      'started: "2026-09-14T01:00:00.000Z"',
      'ended: "2026-09-14T02:00:00.000Z"',
      'name: "我的 \\"会话\\" 名"',
      'source: "2026-09-14T01-00-00_abc-uuid.jsonl"',
      'parent_session: "C:\\\\Users\\\\x\\\\parent.jsonl"',
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
  assert.equal(fm.sessionId, "abc-uuid");
  assert.equal(fm.cwd, "/tmp/proj");
  assert.equal(fm.started, "2026-09-14T01:00:00.000Z");
  assert.equal(fm.ended, "2026-09-14T02:00:00.000Z");
  assert.equal(fm.name, '我的 "会话" 名');
  assert.equal(fm.source, "2026-09-14T01-00-00_abc-uuid.jsonl");
  assert.equal(fm.parentSession, "C:\\Users\\x\\parent.jsonl");
  assert.equal(fm.messageCount, 12);

  assert.deepEqual(parseGardenFrontmatter("no frontmatter"), {});
  assert.deepEqual(parseGardenFrontmatter("---\nname: not-json\n---\n"), {});
});

test("extractFirstUserMessage: 首个 User 小节正文；无则 undefined", () => {
  assert.equal(extractFirstUserMessage(USER_BODY), "请读取 package.json 并总结");
  assert.equal(extractFirstUserMessage("\n## ✨ Assistant · 01:00:06\n\n只有助手\n"), undefined);
  assert.equal(extractFirstUserMessage(""), undefined);
});

test("stripFrontmatter / collectMdFiles / collectSubdirs", async () => {
  const { root, gardenDir } = setup();
  try {
    assert.equal(stripFrontmatter("---\na: 1\n---\n\n正文\n"), "\n正文\n");
    writeFileSync(path.join(gardenDir, "a.l2.md"), "x");
    writeFileSync(path.join(gardenDir, "b.txt"), "x");
    writeFileSync(path.join(gardenDir, ".hidden.md"), "x");
    assert.deepEqual(await collectMdFiles(gardenDir), ["a.l2.md"]);
    assert.deepEqual(await collectMdFiles(path.join(root, "nope")), []);

    mkdirSync(path.join(root, "garden", "--other--"));
    mkdirSync(path.join(root, "garden", ".mono"));
    const subs = await collectSubdirs(path.join(root, "garden"));
    assert.deepEqual(subs.map((s) => path.basename(s)), ["--other--", "--tmp-proj--"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjectSessions: 从 md 重建 item（路径/计数/firstMessage/parentSession）", async () => {
  const { root, gardenDir, sub } = setup();
  try {
    writeFileSync(
      path.join(gardenDir, "2026-09-14-001-起名了.l2.md"),
      buildMd(
        {
          session_id: "aaaa",
          cwd: "/tmp/proj",
          started: "2026-09-14T01:00:00.000Z",
          ended: "2026-09-14T02:00:00.000Z",
          name: "起名了",
          source: "2026-09-14T01-00-00_aaaa.jsonl",
        },
        USER_BODY,
      ) + "messages 正文词\n",
    );
    // fork：parent_session 是 Windows 反斜杠全路径 → basename 配对
    writeFileSync(
      path.join(gardenDir, "2026-09-14-002-fork.l2.md"),
      buildMd({
        session_id: "bbbb",
        cwd: "/tmp/proj",
        started: "2026-09-14T03:00:00.000Z",
        source: "2026-09-14T03-00-00_bbbb.jsonl",
        parent_session: "C:\\Users\\x\\.pi\\agent\\sessions\\--tmp-proj--\\2026-09-14T01-00-00_aaaa.jsonl",
      }),
    );
    // 旧版产物（无 source）→ 跳过
    writeFileSync(path.join(gardenDir, "legacy.l2.md"), buildMd({ session_id: "cccc" }));

    const progress: [number, number][] = [];
    const items = await listProjectSessions(gardenDir, { onProgress: (l, t) => progress.push([l, t]) });
    assert.equal(items.length, 2, "无 source 的 legacy 产物跳过");
    assert.equal(progress.at(-1)?.[1], 3, "进度分母 = 候选 md 文件数");

    const a = items.find((i) => i.id === "aaaa")!;
    assert.equal(a.path, path.join(root, "sessions", sub, "2026-09-14T01-00-00_aaaa.jsonl"), "jsonl 路径由 source 重建");
    assert.equal(a.name, "起名了");
    assert.equal(a.messageCount, 0, "未写 messages 块 → 0");
    assert.equal(a.firstMessage, "请读取 package.json 并总结", "firstMessage 取自首个 User 小节");
    assert.ok(a.allMessagesText.includes("正文词"), "正文成为搜索语料");
    assert.ok(!a.allMessagesText.includes("session_id:"), "语料已剥 frontmatter");
    assert.deepEqual(a.created, new Date("2026-09-14T01:00:00.000Z"));
    assert.deepEqual(a.modified, new Date("2026-09-14T02:00:00.000Z"));
    assert.equal(a.mdDir, gardenDir);
    assert.equal(a.mdBase, "2026-09-14-001-起名了");

    const b = items.find((i) => i.id === "bbbb")!;
    assert.equal(
      b.parentSessionPath,
      path.join(root, "sessions", sub, "2026-09-14T01-00-00_aaaa.jsonl"),
      "parentSession 取 basename 重建（Windows 反斜杠也配对）",
    );
    assert.equal(b.firstMessage, "(no messages)", "无 User 小节兜底");
    assert.equal(b.messageCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjectSessions: 级别优选 l2；同 session 去重（新命名优先，再比 mtime）", async () => {
  const { root, gardenDir } = setup();
  try {
    // 同 base 多级别：l0 与 l2 → 用 l2 的正文
    writeFileSync(path.join(gardenDir, "2026-09-14-001-甲.l0.md"), buildMd({ session_id: "aaaa", source: "a.jsonl" }, "\nl0 独有词\n"));
    writeFileSync(path.join(gardenDir, "2026-09-14-001-甲.l2.md"), buildMd({ session_id: "aaaa", source: "a.jsonl" }, "\nl2 独有词\n"));
    // 同 session 两个 base（改名残留）：都是新命名 → mtime 新者胜
    writeFileSync(path.join(gardenDir, "2026-09-14-002-旧名.l2.md"), buildMd({ session_id: "bbbb", source: "b.jsonl", name: "旧名" }));
    writeFileSync(path.join(gardenDir, "2026-09-14-003-新名.l2.md"), buildMd({ session_id: "bbbb", source: "b.jsonl", name: "新名" }));
    const old = new Date("2026-09-14T04:00:00Z");
    const newer = new Date("2026-09-14T05:00:00Z");
    utimesSync(path.join(gardenDir, "2026-09-14-002-旧名.l2.md"), old, old);
    utimesSync(path.join(gardenDir, "2026-09-14-003-新名.l2.md"), newer, newer);
    // 旧命名风格 vs 新命名风格：新命名优先（不论 mtime）
    writeFileSync(path.join(gardenDir, "2026-09-14T01-00-00_cccc.l2.md"), buildMd({ session_id: "cccc", source: "c.jsonl", name: "旧风格" }));
    writeFileSync(path.join(gardenDir, "2026-09-14-004-新风格.l2.md"), buildMd({ session_id: "cccc", source: "c.jsonl", name: "新风格" }));
    utimesSync(path.join(gardenDir, "2026-09-14T01-00-00_cccc.l2.md"), newer, newer); // 旧风格 mtime 更新也不应赢

    const items = await listProjectSessions(gardenDir);
    assert.equal(items.length, 3);
    assert.ok(items.find((i) => i.id === "aaaa")!.allMessagesText.includes("l2 独有词"), "同 base 优选 l2");
    assert.equal(items.find((i) => i.id === "bbbb")!.name, "新名", "同风格残留取 mtime 新者");
    assert.equal(items.find((i) => i.id === "cccc")!.name, "新风格", "新命名风格优先");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjectSessions: fullText=false 只读 frontmatter（语料为空，其余字段在）", async () => {
  const { root, gardenDir } = setup();
  try {
    writeFileSync(
      path.join(gardenDir, "2026-09-14-001-甲.l2.md"),
      buildMd({ session_id: "aaaa", source: "a.jsonl", name: "甲" }, USER_BODY) + "messages:\n  user: 9\n",
    );
    // 把 messages 块写进 frontmatter 才计数：重写一个规范版本
    writeFileSync(
      path.join(gardenDir, "2026-09-14-002-乙.l2.md"),
      [
        "---",
        'session_id: "bbbb"',
        'source: "b.jsonl"',
        'name: "乙"',
        "messages:",
        "  user: 9",
        "---",
        "",
        "正文语料词",
      ].join("\n"),
    );
    const items = await listProjectSessions(gardenDir, { fullText: false });
    const b = items.find((i) => i.id === "bbbb")!;
    assert.equal(b.name, "乙");
    assert.equal(b.messageCount, 9);
    assert.equal(b.allMessagesText, "", "fullText 关闭 → 无搜索语料");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listAllSessions: 跨子目录聚合；gardenDir/gardenRoot 推导", async () => {
  const { root, gardenDir } = setup();
  try {
    writeFileSync(path.join(gardenDir, "2026-09-14-001-甲.l2.md"), buildMd({ session_id: "aaaa", source: "a.jsonl" }));
    const sub2 = path.join(root, "garden", "--tmp-other--");
    mkdirSync(sub2, { recursive: true });
    writeFileSync(path.join(sub2, "2026-09-14-002-乙.l2.md"), buildMd({ session_id: "bbbb", source: "b.jsonl" }));

    const items = await listAllSessions(path.join(root, "garden"));
    assert.equal(items.length, 2);
    const b = items.find((i) => i.id === "bbbb")!;
    assert.equal(b.path, path.join(root, "sessions", "--tmp-other--", "b.jsonl"), "各子目录独立重建 jsonl 路径");

    const sessionDir = path.join(root, "sessions", "--tmp-proj--");
    assert.equal(gardenDirForSessionDir(sessionDir), gardenDir);
    assert.equal(gardenRootForSessionDir(sessionDir), path.join(root, "garden"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
