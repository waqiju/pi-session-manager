import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, merge, selectModel } from "../src/psm/config.ts";
import { startRun } from "../src/psm/cli.ts";
import { alive, findRun, inspectRun, listRuns } from "../src/psm/runs.ts";
import { archiveFile, submitPrompt } from "../src/psm/interaction.ts";
import { atomicWrite, delay, readJson, writeJson } from "../src/psm/files.ts";

const fixture = fileURLToPath(new URL("./fixtures/psm-fake-pi.ts", import.meta.url));
async function until(check: () => any, timeout = 7000): Promise<any> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(30); }
  throw new Error("Timed out waiting for fixture");
}
function setup(t: any, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "psm-test-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project with spaces");
  mkdirSync(cwd);
  writeJson(path.join(home, "config.json"), { defaultModel: "fake", models: { fake: { provider: "fixture", model: "test" } },
    piCommand: [process.execPath, fixture], pollMs: 30, stableMs: 90, startupTimeoutMs: 3000, turnTimeoutMs: 5000, ...extra });
  const previous = process.env.PSM_HOME;
  process.env.PSM_HOME = home;
  t.after(async () => {
    try {
      for (const run of listRuns(home, true)) {
        if (run.alive) {
          writeJson(path.join(run.dir, "stop.json"), { token: run.token });
          await until(() => !alive(readJson(path.join(run.dir, "run.json"))), 8000);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.PSM_HOME; else process.env.PSM_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, home, cwd };
}
const status = (dir: string, n: string) => readJson(path.join(dir, `${n}.status.json`), {});

test("prompt CLI queues concurrent UTF-8 inputs and open uses garden's configured opener", async (t) => {
  const { cwd, root } = setup(t, { stableMs: 300 });
  const run = await startRun(cwd, "first");
  const cli = fileURLToPath(new URL("../src/psm/cli.ts", import.meta.url));
  const exec = promisify(execFile);
  const promptFile = path.join(root, "multi line.md");
  writeFileSync(promptFile, "中文\nsecond line\n");
  const results = await Promise.all([
    exec(process.execPath, [cli, "prompt", "1", "--file", promptFile, "--json"], { cwd: root }),
    exec(process.execPath, [cli, "prompt", "01", "third", "--json"], { cwd: root }),
  ]);
  const published = results.map((r) => JSON.parse(r.stdout));
  assert.deepEqual(published.map((r) => r.number).sort(), ["002", "003"]);
  assert.equal(readFileSync(published[0].input, "utf8"), "中文\nsecond line\n");
  await until(() => status(run.dir, "003").state === "completed");
  for (const n of ["001", "002", "003"]) {
    const reply = readFileSync(path.join(run.dir, `${n}.out.md`), "utf8");
    const start = Number(reply.match(/detail_start_line: (\d+)/)![1]);
    const end = Number(reply.match(/detail_end_line: (\d+)/)![1]);
    const detail = readFileSync(path.join(run.dir, "session.l1.md"), "utf8").split("\n").slice(start - 1, end).join("\n");
    assert.match(detail, /^## 🙋 User/);
    assert.equal((detail.match(/## 🙋 User/g) || []).length, 1);
    assert.match(detail, new RegExp(`reply ${Number(n)}:`));
  }
  assert.equal(archiveFile(run.dir), path.join(run.dir, "session.l1.md"));
  assert.throws(() => archiveFile(run.dir, "l2"), /l1 or l3/);
  const opener = path.join(root, "opener.mjs");
  const opened = path.join(root, "opened.json");
  writeFileSync(opener, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(opened)}, JSON.stringify(process.argv.slice(2)));`);
  const env = { ...process.env, PI_GARDEN_OPEN_CMD: `${process.execPath} ${opener}` };
  await exec(process.execPath, [cli, "open", "1"], { cwd: root, env });
  await until(() => existsSync(opened));
  assert.deepEqual(readJson(opened), [path.join(run.dir, "session.l1.md")]);
  rmSync(opened);
  await exec(process.execPath, [cli, "open", "1", "--level", "l3"], { cwd: root, env });
  await until(() => existsSync(opened));
  assert.deepEqual(readJson(opened), [path.join(run.dir, "session.l3.md")]);
  await assert.rejects(exec(process.execPath, [cli, "prompt", "1", "text", "--file", promptFile]), /Usage/);
  await assert.rejects(submitPrompt(run.dir, " \n"), /empty/);
  await exec(process.execPath, [cli, "stop", "1"], { cwd: root });
  await assert.rejects(submitPrompt(run.dir, "late"), /Cannot submit/);
});

test("archive failure preserves successful reply with unavailable detail marker", async (t) => {
  const { cwd } = setup(t, { stableMs: 300 });
  const run = await startRun(cwd, "first");
  mkdirSync(path.join(run.dir, "session.l1.md"));
  await until(() => status(run.dir, "001").state === "completed");
  assert.ok(inspectRun(run.dir).archiveError);
  assert.match(readFileSync(path.join(run.dir, "001.out.md"), "utf8"), /detail_status: unavailable[\s\S]*reply 1: first/);
});

test("configuration merges ordinary fields and selects a whole models file", (t) => {
  const { home, cwd } = setup(t);
  writeJson(path.join(home, "models.json"), { providers: { demo: { baseUrl: "https://example.invalid", models: [{ id: "a", maxTokens: 100 }, { id: "b" }] } } });
  writeJson(path.join(cwd, ".psm/models.json"), { providers: { demo: { models: [{ id: "a", maxTokens: 200 }] } } });
  writeJson(path.join(cwd, ".psm/config.json"), { models: { fake: { thinking: "high" } } });
  const loaded = loadConfig(cwd);
  assert.equal(loaded.modelsFile, path.join(cwd, ".psm/models.json"));
  assert.equal(readJson(loaded.modelsFile!).providers.demo.models.length, 1);
  rmSync(loaded.modelsFile!);
  assert.equal(loadConfig(cwd).modelsFile, path.join(home, "models.json"));
  writeFileSync(path.join(cwd, ".psm/models.json"), '{"apiKey":"secret-value", BROKEN');
  assert.throws(() => loadConfig(cwd), (error: Error) => /Invalid models.json/.test(error.message) && !error.message.includes("secret-value"));
  rmSync(path.join(cwd, ".psm/models.json"));
  rmSync(path.join(home, "models.json"));
  assert.equal(loadConfig(cwd).modelsFile, undefined);
  assert.deepEqual(selectModel(loaded.config), { provider: "fixture", model: "test", thinking: "high" });
  assert.deepEqual(loaded.auth, {});
  assert.throws(() => selectModel(loaded.config, "unknown"), /Unknown/);
  assert.throws(() => merge({}, JSON.parse('{"__proto__":{}}')), /Invalid/);
  writeJson(path.join(cwd, ".psm/config.json"), { pollMs: 0 });
  assert.throws(() => loadConfig(cwd), /pollMs/);
});

test("detached RPC: serial files, no early agent_end completion, UTF-8, archives, list and stop", async (t) => {
  const { cwd, home } = setup(t);
  const run = await startRun(cwd, "first 中文\u2028line", undefined, "research");
  assert.equal(run.id, "000001");
  assert.ok(existsSync(path.join(run.dir, "logs/stderr.log")));
  assert.equal(existsSync(path.join(run.dir, "stderr.log")), false);
  assert.ok(alive(run));
  const observed = readJson(path.join(run.dir, "observed.json"));
  assert.equal(observed.cwd, cwd);
  assert.equal(observed.agent, path.join(run.dir, "agent"));
  assert.equal(observed.parentSession, undefined);
  assert.ok(observed.args.includes("--no-extensions"));
  atomicWrite(path.join(run.dir, "002.in.md"), "second");
  await until(() => status(run.dir, "001").state === "running");
  assert.equal(existsSync(path.join(run.dir, "001.out.md")), false);
  await until(() => status(run.dir, "002").state === "completed");
  assert.equal(readFileSync(path.join(run.dir, "001.out.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n\n/, ""), "reply 1: first 中文\u2028line");
  assert.equal(readFileSync(path.join(run.dir, "002.out.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n\n/, ""), "reply 2: second");
  for (const level of ["l1", "l3"]) assert.match(readFileSync(path.join(run.dir, `session.${level}.md`), "utf8"), /second/);
  assert.ok(existsSync(path.join(run.dir, "logs/events.jsonl")));
  assert.equal(inspectRun(run.dir).archiveError, undefined);
  assert.equal(listRuns(home)[0].id, run.id);
  assert.equal(findRun(run.id.slice(0, 8), home).id, run.id);
  // Editing an already consumed input must not resubmit it.
  atomicWrite(path.join(run.dir, "001.in.md"), "edited");
  await delay(200);
  assert.equal(readFileSync(path.join(run.dir, "prompts.jsonl"), "utf8").trim().split("\n").length, 2);
  writeJson(path.join(run.dir, "stop.json"), { token: run.token });
  await until(() => inspectRun(run.dir).state === "stopped");
  assert.equal(inspectRun(run.dir).alive, false);
});

test("fast completion before acceptance response, handled commands, failed and aborted turns", async (t) => {
  const { cwd } = setup(t);
  const run = await startRun(cwd, "fast");
  await until(() => status(run.dir, "001").state === "completed");
  atomicWrite(path.join(run.dir, "002.in.md"), "handled");
  await until(() => status(run.dir, "002").state === "handled");
  atomicWrite(path.join(run.dir, "003.in.md"), "error");
  await until(() => status(run.dir, "003").state === "failed");
  assert.match(status(run.dir, "003").error, /provider failure/);
  assert.equal(existsSync(path.join(run.dir, "003.out.md")), false);
  atomicWrite(path.join(run.dir, "004.in.md"), "abort");
  await until(() => status(run.dir, "004").state === "aborted");
  atomicWrite(path.join(run.dir, "005.in.md"), "recovered");
  await until(() => status(run.dir, "005").state === "completed");
  atomicWrite(path.join(run.dir, "006.in.md"), "reject");
  await until(() => status(run.dir, "006").state === "failed");
  assert.match(status(run.dir, "006").error, /rejection/);
  assert.equal(inspectRun(run.dir).state, "idle");
});

test("incomplete files wait for stability and missing sequence; invalid numbers fail explicitly", async (t) => {
  const { cwd } = setup(t, { stableMs: 250 });
  const run = await startRun(cwd, "first");
  await until(() => status(run.dir, "001").state === "completed");
  atomicWrite(path.join(run.dir, "003.in.md"), "third");
  writeFileSync(path.join(run.dir, "002.in.md"), "partial");
  await delay(100);
  writeFileSync(path.join(run.dir, "002.in.md"), "complete");
  await delay(100);
  assert.equal(status(run.dir, "002").state, undefined);
  await until(() => status(run.dir, "003").state === "completed");
  assert.match(readFileSync(path.join(run.dir, "002.out.md"), "utf8"), /complete/);
  atomicWrite(path.join(run.dir, "1000.in.md"), "overflow");
  await until(() => inspectRun(run.dir).state === "failed");
  assert.match(inspectRun(run.dir).error!, /Invalid input number/);
});

for (const prompt of ["crash", "hang"]) {
  test(`unexpected ${prompt} marks outcome interrupted without replay`, async (t) => {
    const { cwd, home } = setup(t, { turnTimeoutMs: 350 });
    const run = await startRun(cwd, prompt).catch(() => listRuns(home, true)[0]);
    await until(() => inspectRun(run.dir).state === "failed");
    assert.equal(status(run.dir, "001").state, "interrupted");
    assert.equal(existsSync(path.join(run.dir, "001.out.md")), false);
    assert.equal(readFileSync(path.join(run.dir, "prompts.jsonl"), "utf8").trim().split("\n").length, 1);
  });
}

test("CLI exits while worker survives; status/list/stop work from another cwd", async (t) => {
  const { cwd, root, home } = setup(t);
  const cli = fileURLToPath(new URL("../src/psm/cli.ts", import.meta.url));
  const exec = promisify(execFile);
  const linked = path.join(root, "psm");
  symlinkSync(cli, linked);
  const help = await exec(process.execPath, [linked, "--help"], { cwd });
  assert.match(help.stdout, /file-driven background Pi sessions/);
  const { stdout } = await exec(process.execPath, [linked, "hang", "--json"], { cwd, env: { ...process.env, PSM_HOME: home } });
  const run = JSON.parse(stdout);
  await until(() => status(run.dir, "001").state === "running");
  assert.equal(inspectRun(run.dir).alive, true);
  const listed = await exec(process.execPath, [cli, "list", "--json"], { cwd: root });
  assert.equal(JSON.parse(listed.stdout)[0].id, run.id);
  const result = await exec(process.execPath, [cli, "stop", run.id], { cwd: root });
  assert.equal(JSON.parse(result.stdout).state, "stopped");
  assert.equal(status(run.dir, "001").state, "interrupted");
  assert.equal(existsSync(path.join(run.dir, "001.out.md")), false);
});

test("stop cancels a worker blocked during RPC startup", async (t) => {
  const { cwd, home } = setup(t, { models: { fake: { provider: "fixture", model: "startup-hang" } }, startupTimeoutMs: 15000 });
  const starting = startRun(cwd, "first").catch((error) => error);
  const run = await until(() => listRuns(home, true).find((r) => r.alive));
  writeJson(path.join(run.dir, "stop.json"), { token: run.token });
  await until(() => inspectRun(run.dir).state === "stopped");
  assert.match((await starting).message, /stopped/);
});

test("missing executable startup is diagnosed and recorded", async (t) => {
  const { cwd, home } = setup(t, { piCommand: ["/definitely-not-a-pi-binary"] });
  await assert.rejects(startRun(cwd, "first"), /ENOENT/);
  assert.equal(listRuns(home, true)[0].state, "failed");
});

test("list includes live old runs and recent history, stale heartbeat is interrupted", (t) => {
  const { home, root } = setup(t);
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  const base = { schema: 1, config: { pollMs: 100, startupTimeoutMs: 3000 }, state: "idle", workerPid: process.pid,
    heartbeatAt: new Date().toISOString(), createdAt: old, updatedAt: old };
  for (const id of ["live", "stale", "stopped"]) {
    const dir = path.join(root, id);
    writeJson(path.join(dir, "run.json"), { ...base, id, dir, ...(id === "stale" ? { heartbeatAt: old } : {}), ...(id === "stopped" ? { state: "stopped" } : {}) });
    writeJson(path.join(home, "registry", `${id}.json`), { id, dir });
  }
  assert.deepEqual(listRuns(home).map((r) => r.id), ["live"]);
  assert.equal(findRun("stale", home).state, "interrupted");
  assert.equal(listRuns(home, true).length, 3);
  // Do not ask teardown to stop this test process.
  writeJson(path.join(root, "live/run.json"), { ...base, id: "live", dir: path.join(root, "live"), state: "stopped" });
});
