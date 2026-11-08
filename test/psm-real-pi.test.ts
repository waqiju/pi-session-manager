import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { followLogs } from "../src/psm/logs.ts";
import { startRun } from "../src/psm/cli.ts";
import { requestStop, restartRun } from "../src/psm/lifecycle.ts";
import { submitPrompt } from "../src/psm/interaction.ts";
import { atomicWrite, delay, readJson, writeJson } from "../src/psm/files.ts";
import { inspectRun, listRuns } from "../src/psm/runs.ts";

// Opt-in: exercise the installed Pi executable with a local, deterministic API server.
// No real provider credentials, external requests, or billable model calls.
test("real Pi RPC with isolated local OpenAI-compatible endpoint", { skip: !process.env.PSM_REAL_PI, timeout: 45000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "psm-real-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  const previous = process.env.PSM_HOME;
  process.env.PSM_HOME = home;
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (delta: any, finish_reason: string | null = null) => ({ id: `chat-${requests.length}`, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: "psm-test", choices: [{ index: 0, delta, finish_reason }] });
      response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: `local answer ${requests.length}` }))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  writeJson(path.join(home, "config.json"), { defaultModel: "psm-local/psm-te:high",
    piCommand: [process.env.PSM_REAL_PI], pollMs: 50, stableMs: 100, startupTimeoutMs: 15000, turnTimeoutMs: 10000 });
  writeJson(path.join(home, "models.json"), { providers: { "psm-local": { baseUrl: `http://127.0.0.1:${address.port}/v1`,
    api: "openai-completions", apiKey: "local-test-only", models: [{ id: "psm-test", contextWindow: 32768, maxTokens: 256 }] } } });
  const wait = async (check: () => boolean, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (check()) return; await delay(50); }
    throw new Error("Real Pi integration timed out");
  };
  try {
    const run = await startRun(cwd, "Reply briefly; do not call tools.");
    assert.equal(run.requestedModel, "psm-local/psm-te:high");
    assert.deepEqual(run.model, { provider: "psm-local", model: "psm-test", thinking: "off" });
    for (const n of ["001", "002"]) {
      if (n === "002") atomicWrite(path.join(run.dir, "002.in.md"), "Reply again using prior context; do not call tools.");
      await wait(() => ["completed", "failed", "interrupted"].includes(readJson(path.join(run.dir, `${n}.status.json`), {}).state));
      assert.equal(readJson(path.join(run.dir, `${n}.status.json`)).state, "completed");
      assert.equal(readFileSync(path.join(run.dir, `${n}.out.md`), "utf8").replace(/^---\n[\s\S]*?\n---\n\n/, ""), `local answer ${Number(n)}`);
    }
    assert.equal(requests.length, 2);
    let transcript = "";
    await followLogs(run.dir, { format: "text", lines: 1000, follow: false,
      write: async (text) => { transcript += text; }, diagnostic: () => {} });
    assert.equal(transcript.split("local answer 1").length - 1, 1);
    assert.equal(transcript.split("local answer 2").length - 1, 1);
    assert.ok(requests[1].messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("local answer 1")));
    assert.match(readFileSync(path.join(run.dir, "session.l3.md"), "utf8"), /local answer 2/);
    assert.equal(inspectRun(run.dir).archiveError, undefined);
    await requestStop(run.dir);
    await wait(() => inspectRun(run.dir).state === "stopped");
    const restarted = await restartRun(run.dir);
    assert.equal(restarted.id, run.id);
    assert.equal(restarted.restartCount, 1);
    await submitPrompt(run.dir, "Continue after restart using prior context; do not call tools.");
    await wait(() => readJson(path.join(run.dir, "003.status.json"), {}).state === "completed");
    assert.equal(requests.length, 3);
    for (const text of ["local answer 1", "local answer 2"]) {
      assert.ok(requests[2].messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes(text)));
    }
    assert.match(readFileSync(path.join(run.dir, "003.out.md"), "utf8"), /local answer 3/);
    assert.match(readFileSync(path.join(run.dir, "session.l3.md"), "utf8"), /local answer 1[\s\S]*local answer 3/);
    await requestStop(run.dir);
    await wait(() => inspectRun(run.dir).state === "stopped");
  } finally {
    for (const run of listRuns(home, true)) {
      if (run.alive) {
        writeJson(path.join(run.dir, "stop.json"), { token: run.token });
        await wait(() => !inspectRun(run.dir).alive, 10000);
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PSM_HOME; else process.env.PSM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
