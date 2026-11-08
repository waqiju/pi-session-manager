import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJson } from "../src/psm/files.ts";
import { EventReader, TextEvents, followLogs } from "../src/psm/logs.ts";

function fixture(t: any) {
  const dir = mkdtempSync(path.join(tmpdir(), "psm-logs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "events.jsonl") };
}

test("tail reads across chunks, retains partial UTF-8 records and follows replacement/truncation", (t) => {
  const { file } = fixture(t);
  writeFileSync(file, Array.from({ length: 10000 }, (_, n) => JSON.stringify({ n, text: "中文" })).join("\n") + "\n");
  const reader = new EventReader(file, 3);
  assert.deepEqual([...reader.read()].map((line) => JSON.parse(line).n), [9997, 9998, 9999]);
  const record = Buffer.from('{"text":"中文"}\n');
  const cut = record.indexOf(Buffer.from("中")) + 1;
  appendFileSync(file, record.subarray(0, cut));
  assert.deepEqual([...reader.read()], []);
  appendFileSync(file, record.subarray(cut));
  assert.deepEqual([...reader.read()], ['{"text":"中文"}']);
  writeFileSync(file, '{"new":true}\n');
  assert.deepEqual([...reader.read()], ['{"new":true}']);
  writeFileSync(file + ".new", '{"replaced":true}\n');
  renameSync(file + ".new", file);
  assert.deepEqual([...reader.read()], ['{"replaced":true}']);
});

test("tail includes an incomplete last record and handles absent/empty files and zero history", (t) => {
  const { file } = fixture(t);
  const reader = new EventReader(file, 1);
  assert.deepEqual([...reader.read()], []);
  writeFileSync(file, 'old\n{"partial":');
  assert.deepEqual([...reader.read()], []);
  appendFileSync(file, '1}\n');
  assert.deepEqual([...reader.read()], ['{"partial":1}']);
  const zero = new EventReader(file, 0);
  assert.deepEqual([...zero.read()], []);
  appendFileSync(file, 'next\n');
  assert.deepEqual([...zero.read()], ['next']);
  appendFileSync(file, '{"unfinished":');
  const fromNow = new EventReader(file, 0);
  assert.deepEqual([...fromNow.read()], []);
  appendFileSync(file, '1}\n{"fresh":true}\n');
  assert.deepEqual([...fromNow.read()], ['{"fresh":true}']);
});

const msg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
test("text joins mid-stream, deduplicates snapshots/end and handles separate messages", () => {
  const formatter = new TextEvents();
  assert.equal(formatter.format({ type: "message_update", message: msg("你好") }), "你好");
  assert.equal(formatter.format({ type: "message_update", message: msg("你好 world") }), " world");
  assert.equal(formatter.format({ type: "message_end", message: msg("你好 world!") }), "!\n");
  assert.equal(formatter.format({ type: "message_end", message: msg("你好 world!") }), "你好 world!\n");
  assert.equal(formatter.format({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta only" } }), "delta only");
  assert.equal(formatter.format({ type: "message_end", message: msg("delta only") }), "\n");
  assert.equal(formatter.format({ type: "tool_execution_update", partialResult: { text: "large repeated snapshot" } }), "");
  assert.match(formatter.format({ type: "tool_execution_start", toolName: "bash", toolCallId: "a" }), /bash started/);
  assert.match(formatter.format({ type: "tool_execution_end", toolName: "bash", toolCallId: "a", isError: true, result: { content: [{ type: "text", text: "oops" }] } }), /bash failed.*oops/);
  assert.match(formatter.format({ type: "auto_retry_start", attempt: 2, errorMessage: "busy" }), /retry 2.*busy/);
  assert.match(formatter.format({ type: "response", success: false, error: "rejected" }), /rejected/);
});

test("text preserves Markdown source and strips terminal controls", () => {
  const formatter = new TextEvents();
  assert.equal(formatter.format({ type: "message_end", message: msg("# Heading\n```ts\n中文\n```\u001b[2J") }), "# Heading\n```ts\n中文\n```\n");
});

test("follow stays through idle, prints appended events and drains before terminal exit", async (t) => {
  const { dir } = fixture(t);
  mkdirSync(path.join(dir, "logs"));
  const file = path.join(dir, "logs", "events.jsonl");
  writeFileSync(file, '{"type":"agent_start"}\n');
  const run = { id: "000001", state: "idle", workerPid: process.pid, heartbeatAt: new Date().toISOString(), config: { pollMs: 100 } };
  writeJson(path.join(dir, "run.json"), run);
  let output = "";
  let diagnostics = "";
  const timer = setTimeout(() => {
    appendFileSync(file, JSON.stringify({ type: "message_end", message: msg("late answer") }) + "\n");
    writeJson(path.join(dir, "run.json"), { ...run, state: "failed", error: "fixture failure" });
  }, 250);
  t.after(() => clearTimeout(timer));
  await followLogs(dir, { format: "text", lines: 100, follow: true, signal: AbortSignal.timeout(3000),
    write: async (text) => { output += text; }, diagnostic: (text) => { diagnostics += text; } });
  assert.match(output, /running[\s\S]*late answer/);
  assert.match(diagnostics, /failed.*fixture failure/);
});

test("JSON output preserves records, skips malformed lines and stops on abort", async (t) => {
  const { dir } = fixture(t);
  mkdirSync(path.join(dir, "logs"));
  writeFileSync(path.join(dir, "logs", "events.jsonl"), '{"type":"unknown","n":1}\nbad\n{"type":"unknown","n":2}\n');
  let output = "";
  let diagnostics = "";
  await followLogs(dir, { format: "json", lines: 100, follow: false,
    write: async (text) => { output += text; }, diagnostic: (text) => { diagnostics += text; } });
  assert.deepEqual(output.trim().split("\n").map((line) => JSON.parse(line).n), [1, 2]);
  assert.match(diagnostics, /malformed/);
  const controller = new AbortController();
  controller.abort();
  await followLogs(dir, { format: "text", lines: 0, follow: true, signal: controller.signal,
    write: async () => assert.fail("aborted"), diagnostic: () => {} });
});
