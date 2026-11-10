import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { waitForTurn } from "../src/psm/wait.ts";
import { writeJson, readJson, delay } from "../src/psm/files.ts";
import { startRun } from "../src/psm/cli.ts";
import { requestStop } from "../src/psm/lifecycle.ts";
import { submitPrompt } from "../src/psm/interaction.ts";
import { inspectRun, listRuns } from "../src/psm/runs.ts";

const cli = fileURLToPath(new URL("../src/psm/cli.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/psm-fake-pi.ts", import.meta.url));
const exec = promisify(execFile);
function setup(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), "psm-wait-"));
  const dir = path.join(root, "000001");
  mkdirSync(dir);
  const run = { id: "000001", state: "idle", workerPid: process.pid, heartbeatAt: new Date().toISOString(),
    config: { pollMs: 500, startupTimeoutMs: 3000 }, dir };
  writeJson(path.join(dir, "run.json"), run);
  writeFileSync(path.join(dir, "001.in.md"), "first");
  const status = (state: string, number = "001") => writeJson(path.join(dir, `${number}.status.json`), { number, state });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dir, run, status };
}

test("wait pins latest submitted turn, ignores output alone, and does not wait for subsequent prompts", async (t) => {
  const { dir, status } = setup(t);
  writeFileSync(path.join(dir, "002.in.md"), "queued");
  writeFileSync(path.join(dir, "002.out.md"), "not yet committed");
  status("completed");
  let resolved = false;
  const waiting = waitForTurn(dir).then((result) => { resolved = true; return result; });
  writeFileSync(path.join(dir, "003.in.md"), "later");
  await delay(80);
  assert.equal(resolved, false);
  status("completed", "002");
  const result = await waiting;
  assert.equal(result.number, "002");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, path.join(dir, "002.out.md"));
});

test("terminal results take precedence over stopped run; handled has no reply", async (t) => {
  const { dir, run, status } = setup(t);
  writeJson(path.join(dir, "run.json"), { ...run, state: "stopped" });
  for (const state of ["completed", "handled", "failed", "aborted", "interrupted"]) {
    status(state);
    const result = await waitForTurn(dir, { turn: "1" });
    assert.equal(result.state, state);
    assert.equal(result.exitCode, ["completed", "handled"].includes(state) ? 0 : 1);
    assert.equal(!!result.output, state === "completed");
  }
  status("running");
  assert.equal((await waitForTurn(dir)).state, "unavailable");
});

test("wait timeout and cancellation leave run and pending inputs untouched", async (t) => {
  const { dir, run } = setup(t);
  assert.equal((await waitForTurn(dir, { timeoutSeconds: 0.03 })).exitCode, 124);
  const controller = new AbortController();
  const waiting = waitForTurn(dir, { signal: controller.signal });
  controller.abort();
  assert.equal((await waiting).exitCode, 130);
  assert.deepEqual(readJson(path.join(dir, "run.json")), run);
  assert.equal(existsSync(path.join(dir, "stop.json")), false);
});

test("wait validates targets and metadata; tolerates temporary missing run metadata", async (t) => {
  const { dir, run, status } = setup(t);
  for (const turn of ["0", "1000", "-1", "1.5", "x", ""]) await assert.rejects(waitForTurn(dir, { turn }), /--turn/);
  await assert.rejects(waitForTurn(dir, { turn: "2" }), /Submitted turn not found/);
  for (const timeoutSeconds of [0, -1, NaN, Infinity]) await assert.rejects(waitForTurn(dir, { timeoutSeconds }), /--timeout/);
  rmSync(path.join(dir, "run.json"));
  const waiting = waitForTurn(dir, { timeoutSeconds: 3 });
  writeJson(path.join(dir, "run.json"), run);
  status("handled");
  assert.equal((await waiting).state, "handled");
  writeFileSync(path.join(dir, "001.status.json"), "broken JSON");
  await assert.rejects(waitForTurn(dir), /Cannot read JSON/);
});

test("CLI JSON, timeout, signals and worker failures using actual background workers", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "psm-wait-worker-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  writeJson(path.join(home, "config.json"), { defaultModel: "fixture/test", piCommand: [process.execPath, fixture],
    pollMs: 20, stableMs: 60, startupTimeoutMs: 3000, turnTimeoutMs: 15000 });
  const previous = process.env.PSM_HOME;
  process.env.PSM_HOME = home;
  t.after(async () => {
    try {
      for (const run of listRuns(home, true)) {
        if (run.alive) await requestStop(run.dir);
        const deadline = Date.now() + 6000;
        while (inspectRun(run.dir).alive && Date.now() < deadline) await delay(30);
      }
    } finally {
      if (previous === undefined) delete process.env.PSM_HOME; else process.env.PSM_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  const run = await startRun(cwd, "first");
  const submitted = await submitPrompt(run.dir, "second");
  const { stdout } = await exec(process.execPath, [cli, "wait", run.id, "--turn", submitted.number, "--json"], { cwd });
  const result = JSON.parse(stdout);
  assert.equal(result.state, "completed");
  assert.equal(result.number, "002");
  assert.ok(existsSync(result.output));
  assert.equal(inspectRun(run.dir).alive, true);
  for (const [prompt, expected] of [["handled", "handled"], ["error", "failed"], ["abort", "aborted"]]) {
    const turn = await submitPrompt(run.dir, prompt);
    assert.equal((await waitForTurn(run.dir, { turn: turn.number, timeoutSeconds: 5 })).state, expected);
  }
  await submitPrompt(run.dir, "hang");
  await assert.rejects(exec(process.execPath, [cli, "wait", run.id, "--timeout", "0.05", "--json"], { cwd }), (error: any) => {
    assert.equal(error.code, 124);
    assert.equal(JSON.parse(error.stdout).state, "timeout");
    return true;
  });
  const child = spawn(process.execPath, [cli, "wait", run.id, "--json"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on("close", resolve));
  await delay(600);
  child.kill("SIGINT");
  assert.equal(await closed, 130);
  assert.equal(JSON.parse(output).state, "cancelled");
  assert.equal(inspectRun(run.dir).alive, true);
  assert.equal(existsSync(path.join(run.dir, "stop.json")), false);
  const crashed = await startRun(cwd, "first");
  await waitForTurn(crashed.dir, { timeoutSeconds: 5 });
  const crashingTurn = await submitPrompt(crashed.dir, "crash");
  const failure = await waitForTurn(crashed.dir, { turn: crashingTurn.number, timeoutSeconds: 5 });
  assert.equal(failure.exitCode, 1);
  assert.ok(["interrupted", "unavailable"].includes(failure.state));
  await assert.rejects(exec(process.execPath, [cli, "status", run.id, "--timeout", "1"], { cwd }), /--turn and --timeout are for wait/);
});
