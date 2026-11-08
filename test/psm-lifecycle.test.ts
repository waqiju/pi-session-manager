import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startRun } from "../src/psm/cli.ts";
import { restartRun, requestStop } from "../src/psm/lifecycle.ts";
import { submitPrompt } from "../src/psm/interaction.ts";
import { inspectRun, listRuns } from "../src/psm/runs.ts";
import { processIdentity, processPresent, withRunLock } from "../src/psm/control.ts";
import { loadConfig } from "../src/psm/config.ts";
import { atomicWrite, delay, readJson, writeJson } from "../src/psm/files.ts";

const fixture = fileURLToPath(new URL("./fixtures/psm-fake-pi.ts", import.meta.url));
const cli = fileURLToPath(new URL("../src/psm/cli.ts", import.meta.url));
const exec = promisify(execFile);
async function until(check: () => any, timeout = 9000): Promise<any> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = check(); if (result) return result; await delay(20); }
  throw new Error("Lifecycle test timed out");
}
function setup(t: any, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "psm-lifecycle-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  writeJson(path.join(home, "config.json"), { defaultModel: "fixture/test",
    piCommand: [process.execPath, fixture], pollMs: 20, stableMs: 60, startupTimeoutMs: 3000, turnTimeoutMs: 5000, ...extra });
  const previous = process.env.PSM_HOME;
  process.env.PSM_HOME = home;
  t.after(async () => {
    try {
      for (const run of listRuns(home, true)) {
        if (run.alive) {
          await requestStop(run.dir);
          await until(() => ["stopped", "failed"].includes(inspectRun(run.dir).state));
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
async function stopped(dir: string) {
  await requestStop(dir);
  await until(() => inspectRun(dir).state === "stopped");
}

test("idle timeout defaults to 24 hours, supports disabling, rejects invalid values", (t) => {
  const { cwd } = setup(t);
  assert.equal(loadConfig(cwd).config.idleTimeoutMs, 86400000);
  for (const value of [-1, 1.5, "24h"]) {
    writeJson(path.join(cwd, ".psm/config.json"), { idleTimeoutMs: value });
    assert.throws(() => loadConfig(cwd), /idleTimeoutMs/);
  }
  writeJson(path.join(cwd, ".psm/config.json"), { idleTimeoutMs: 0 });
  assert.equal(loadConfig(cwd).config.idleTimeoutMs, 0);
});

test("idle expiry leaves running and queued work alone, then stops and stays in recent list", async (t) => {
  const { cwd, home } = setup(t, { idleTimeoutMs: 80, stableMs: 150 });
  const run = await startRun(cwd, "first");
  await submitPrompt(run.dir, "second");
  await until(() => status(run.dir, "001").state === "running");
  await delay(100);
  assert.equal(inspectRun(run.dir).state, "running");
  await until(() => inspectRun(run.dir).state === "stopped");
  const latest = inspectRun(run.dir);
  assert.equal(status(run.dir, "002").state, "completed");
  assert.equal(latest.stopReason, "idle_timeout");
  assert.equal(latest.lastTurnStatus?.state, "completed");
  assert.ok(latest.idleSince);
  assert.equal(processPresent(latest.piPid, latest.piIdentity), false);
  assert.equal(listRuns(home)[0].id, run.id);
  await assert.rejects(submitPrompt(run.dir, "late"), /Cannot submit/);
});

test("zero disables idle expiry and inspections do not reset idleSince", async (t) => {
  const { cwd } = setup(t, { idleTimeoutMs: 0 });
  const run = await startRun(cwd, "fast");
  await until(() => status(run.dir, "001").state === "completed");
  const idleSince = inspectRun(run.dir).idleSince;
  await delay(1100);
  assert.equal(inspectRun(run.dir).idleSince, idleSince);
  assert.equal(inspectRun(run.dir).state, "idle");
});

test("idle shutdown rechecks input under the same lock used by publishers", async (t) => {
  const { cwd } = setup(t, { idleTimeoutMs: 200 });
  const run = await startRun(cwd, "fast");
  await until(() => status(run.dir, "001").state === "completed");
  await withRunLock(run.dir, async () => {
    await delay(300);
    assert.equal(inspectRun(run.dir).state, "idle");
    atomicWrite(path.join(run.dir, "002.in.md"), "published at expiry");
  });
  await until(() => status(run.dir, "002").state === "completed");
  await until(() => inspectRun(run.dir).state === "stopped");
});

test("restart CLI retains session and ID, resets idle time and token, accepts shorthand", async (t) => {
  const { cwd, root } = setup(t, { idleTimeoutMs: 0 });
  const run = await startRun(cwd, "first");
  await until(() => status(run.dir, "001").state === "completed");
  await stopped(run.dir);
  const before = readFileSync(path.join(run.dir, "session.jsonl"), "utf8");
  // Legacy snapshots have no idle timeout and use createdAt; a restart needs fresh startup grace.
  const saved = readJson(path.join(run.dir, "run.json"));
  saved.createdAt = "2020-01-01T00:00:00.000Z";
  delete saved.config.idleTimeoutMs;
  writeJson(path.join(run.dir, "run.json"), saved);
  const { stdout } = await exec(process.execPath, [cli, "restart", "01", "--json"], { cwd: root });
  const restarted = JSON.parse(stdout);
  assert.equal(restarted.id, run.id);
  assert.equal(restarted.cwd, cwd);
  assert.equal(restarted.restartCount, 1);
  assert.equal(restarted.config.idleTimeoutMs, 86400000);
  assert.notEqual(restarted.token, run.token);
  assert.deepEqual(restarted.pendingTurns, []);
  assert.equal(restarted.stopReason, undefined);
  assert.equal(existsSync(path.join(run.dir, "stop.json")), false);
  assert.equal(readFileSync(path.join(run.dir, "session.jsonl"), "utf8"), before);
  assert.equal((await submitPrompt(run.dir, "second")).number, "002");
  await until(() => status(run.dir, "002").state === "completed");
  assert.ok(readFileSync(path.join(run.dir, "session.jsonl"), "utf8").startsWith(before));
  assert.match(readFileSync(path.join(run.dir, "002.out.md"), "utf8"), /reply 2: second/);
  await assert.rejects(restartRun(run.dir), /Cannot restart/);
});

test("worker crash reconciles running checkpoint, concurrent restart claims once and drains only unsent input", async (t) => {
  const { cwd } = setup(t, { idleTimeoutMs: 0 });
  const run = await startRun(cwd, "hang");
  await until(() => status(run.dir, "001").state === "running");
  await submitPrompt(run.dir, "queued before crash");
  const active = inspectRun(run.dir);
  process.kill(active.workerPid!, "SIGKILL");
  await until(() => !processPresent(active.workerPid, active.workerIdentity));
  await until(() => !processPresent(active.piPid, active.piIdentity));
  assert.equal(inspectRun(run.dir).state, "interrupted");
  assert.equal(status(run.dir, "001").state, "running");
  const results = await Promise.allSettled([restartRun(run.dir), restartRun(run.dir)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const success = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>;
  assert.deepEqual(success.value.pendingTurns, ["002"]);
  await until(() => status(run.dir, "002").state === "completed");
  assert.equal(status(run.dir, "001").state, "interrupted");
  assert.equal(inspectRun(run.dir).restartCount, 1);
  const prompts = readFileSync(path.join(run.dir, "prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).message);
  assert.deepEqual(prompts, ["hang", "queued before crash"]);
  assert.equal((await submitPrompt(run.dir, "third")).number, "003");
});

test("failed run can restart without replaying its interrupted turn", async (t) => {
  const { cwd, home } = setup(t);
  const run = await startRun(cwd, "crash").catch(() => listRuns(home, true)[0]);
  await until(() => inspectRun(run.dir).state === "failed");
  assert.equal(status(run.dir, "001").state, "interrupted");
  const restarted = await restartRun(run.dir);
  assert.equal(restarted.state, "idle");
  assert.equal(restarted.error, undefined);
  await submitPrompt(run.dir, "recovered");
  await until(() => status(run.dir, "002").state === "completed");
  assert.match(readFileSync(path.join(run.dir, "logs/restarts.jsonl"), "utf8"), /Pi exited/);
});

test("restart rejects a live worker or Pi despite stale heartbeat, and does not mutate state", async (t) => {
  const { cwd } = setup(t);
  const run = await startRun(cwd, "fast");
  await until(() => status(run.dir, "001").state === "completed");
  await stopped(run.dir);
  await until(() => !processPresent(run.workerPid, run.workerIdentity));
  const original = readJson(path.join(run.dir, "run.json"));
  for (const kind of ["worker", "pi"]) {
    const fake = { ...original, state: "running", heartbeatAt: "2020-01-01T00:00:00Z", [`${kind}Pid`]: process.pid, [`${kind}Identity`]: processIdentity(process.pid) };
    writeJson(path.join(run.dir, "run.json"), fake);
    try {
      assert.equal(inspectRun(run.dir).state, "interrupted");
      await assert.rejects(restartRun(run.dir), /process still exists/);
      assert.deepEqual(readJson(path.join(run.dir, "run.json")), fake);
    } finally { writeJson(path.join(run.dir, "run.json"), original); }
  }
});

test("restart refuses missing checkpoints and damaged or missing prior session without launching", async (t) => {
  const { cwd } = setup(t);
  const run = await startRun(cwd, "fast");
  await until(() => status(run.dir, "001").state === "completed");
  await stopped(run.dir);
  const file = path.join(run.dir, "session.jsonl");
  const original = readFileSync(file, "utf8");
  atomicWrite(file, original + '{"partial":');
  await assert.rejects(restartRun(run.dir), /damaged session/);
  rmSync(file);
  await assert.rejects(restartRun(run.dir), /Session missing/);
  atomicWrite(file, original);
  rmSync(path.join(run.dir, "001.status.json"));
  await assert.rejects(restartRun(run.dir), /Missing execution checkpoint/);
  assert.equal(inspectRun(run.dir).restartCount, 0);
});

test("restart trusts completed checkpoints when run metadata lagged behind, without replay", async (t) => {
  const { cwd } = setup(t);
  const run = await startRun(cwd, "fast");
  await until(() => status(run.dir, "001").state === "completed");
  await stopped(run.dir);
  const saved = readJson(path.join(run.dir, "run.json"));
  await until(() => !processPresent(saved.workerPid, saved.workerIdentity));
  delete saved.lastTurn;
  saved.state = "running";
  saved.currentTurn = "001";
  writeJson(path.join(run.dir, "run.json"), saved);
  const checkpoint = status(run.dir, "001");
  await restartRun(run.dir);
  assert.deepEqual(status(run.dir, "001"), checkpoint);
  assert.equal(inspectRun(run.dir).lastTurn, "001");
  assert.equal((await submitPrompt(run.dir, "next")).number, "002");
  await until(() => status(run.dir, "002").state === "completed");
  assert.equal(readFileSync(path.join(run.dir, "prompts.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("startup failure before session creation can restart once the executable is repaired", async (t) => {
  const { cwd, home, root } = setup(t);
  const executable = path.join(root, "not-installed-yet.ts");
  writeJson(path.join(cwd, ".psm/config.json"), { piCommand: [process.execPath, executable] });
  await assert.rejects(startRun(cwd, "first"), /Pi exited/);
  const run = listRuns(home, true)[0];
  assert.equal(existsSync(path.join(run.dir, "session.jsonl")), false);
  atomicWrite(executable, readFileSync(fixture, "utf8"));
  const restarted = await restartRun(run.dir);
  assert.deepEqual(restarted.pendingTurns, ["001"]);
  await until(() => status(run.dir, "001").state === "completed");
  assert.equal(inspectRun(run.dir).restartCount, 1);
});

test("process identity guards against PID reuse", () => {
  assert.equal(processPresent(process.pid, processIdentity(process.pid)), true);
  assert.equal(processPresent(process.pid, "different-boot-or-start"), false);
});
