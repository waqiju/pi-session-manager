import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { archiveSession } from "../src/archive.ts";
import { replyDocument, refreshReplyDetails } from "../src/psm/replies.ts";
import { writeJson } from "../src/psm/files.ts";
import { localTime } from "../src/psm/table.ts";

test("entry line mapping includes tools, survives changing frontmatter, and distinguishes identical prompts", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "psm-details-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const header = { type: "session", version: 3, id: "test", timestamp: "2026-11-09T01:00:00Z", cwd: dir };
  const entries: any[] = [];
  function add(message: any) {
    entries.push({ type: "message", id: `e${entries.length}`, parentId: entries.length ? `e${entries.length - 1}` : null,
      timestamp: "2026-11-09T01:00:00Z", message });
  }
  add({ role: "user", content: "same prompt" });
  add({ role: "assistant", content: [{ type: "toolCall", id: "tool1", name: "read", arguments: { path: "file" } }] });
  add({ role: "toolResult", toolCallId: "tool1", toolName: "read", content: [{ type: "text", text: "tool detail\nsecond line" }] });
  add({ role: "assistant", content: [{ type: "text", text: "first answer" }] });
  const session = path.join(dir, "session.jsonl");
  const render = () => {
    writeFileSync(session, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const lines = archiveSession(session, path.join(dir, "session"));
    refreshReplyDetails(dir, lines);
    return lines;
  };
  writeJson(path.join(dir, "001.status.json"), { entryStart: 0, entryEnd: 4 });
  writeFileSync(path.join(dir, "001.out.md"), replyDocument("001", "---\nanswer frontmatter\n---\nfirst answer"));
  const before = render().get(0)!.start;
  add({ role: "user", content: "same prompt" });
  add({ role: "assistant", model: "new-model", content: [{ type: "text", text: "second answer" }] });
  writeJson(path.join(dir, "002.status.json"), { entryStart: 4, entryEnd: 6 });
  writeFileSync(path.join(dir, "002.out.md"), replyDocument("002", "second answer"));
  const after = render().get(0)!.start;
  assert.notEqual(before, after, "adding a model changes frontmatter length");
  const archive = readFileSync(path.join(dir, "session.l1.md"), "utf8").split("\n");
  for (const number of ["001", "002"]) {
    const reply = readFileSync(path.join(dir, `${number}.out.md`), "utf8");
    const start = Number(reply.match(/detail_start_line: (\d+)/)![1]);
    const end = Number(reply.match(/detail_end_line: (\d+)/)![1]);
    const text = archive.slice(start - 1, end).join("\n");
    assert.match(text, /^## 🙋 User/);
    assert.equal(text.match(/same prompt/g)!.length, 1);
    if (number === "001") {
      assert.match(text, /tool detail\nsecond line/);
      assert.match(text, /first answer$/);
      assert.doesNotMatch(text, /second answer/);
      assert.ok(reply.endsWith("---\nanswer frontmatter\n---\nfirst answer"));
    } else assert.match(text, /second answer$/);
  }
  refreshReplyDetails(dir);
  assert.match(readFileSync(path.join(dir, "001.out.md"), "utf8"), /detail_status: unavailable/);
});

test("list timestamp uses local timezone and seconds", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Shanghai";
    assert.equal(localTime("2026-11-08T17:08:16.789Z"), "2026-11-09 01:08:16");
    process.env.TZ = "UTC";
    assert.equal(localTime("2026-11-08T17:08:16.789Z"), "2026-11-08 17:08:16");
    assert.equal(localTime("invalid"), "-");
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
