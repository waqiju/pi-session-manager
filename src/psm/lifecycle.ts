import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { processIdentity, processPresent, withRunLock } from "./control.ts";
import { delay, now, readJson, writeJson } from "./files.ts";
import { inspectRun, type Run } from "./runs.ts";

export async function launchWorker(run: Run): Promise<Run> {
  const log = openSync(path.join(run.dir, "logs", "stderr.log"), "a", 0o600);
  let spawned = false;
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.ts", import.meta.url)), run.dir, run.token], {
      cwd: run.cwd, detached: true, stdio: ["ignore", log, log], env: process.env,
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    spawned = true;
    child.unref();
    writeJson(path.join(run.dir, "launch.json"), { token: run.token, pid: child.pid, identity: processIdentity(child.pid!) });
  } catch (error: any) {
    // A failure to record a spawned child must not pretend that it has exited.
    const latest: Run = readJson(path.join(run.dir, "run.json"));
    if (!spawned && !latest.workerPid) {
      latest.state = "failed"; latest.error = error.message; latest.stopReason = "error"; latest.updatedAt = now();
      writeJson(path.join(run.dir, "run.json"), latest);
    }
    throw new Error(`Worker startup failed: ${error.message}; run directory: ${run.dir}`);
  } finally { closeSync(log); }
  const deadline = Date.now() + run.config.startupTimeoutMs + 2000;
  while (Date.now() < deadline) {
    const latest = inspectRun(run.dir);
    if (latest.token !== run.token) throw new Error("Worker generation changed during startup");
    if (latest.state === "idle" || latest.state === "running") return latest;
    if (["failed", "stopped", "interrupted"].includes(latest.state)) throw new Error(`${latest.error || latest.state}; run directory: ${run.dir}`);
    await delay(100);
  }
  writeJson(path.join(run.dir, "stop.json"), { token: run.token, requestedAt: now() });
  throw new Error(`Startup timed out; shutdown requested. Inspect ${run.dir}/logs/stderr.log`);
}

export async function requestStop(dir: string): Promise<Run> {
  return withRunLock(dir, () => {
    const run = inspectRun(dir);
    if (run.alive || run.state === "starting") writeJson(path.join(dir, "stop.json"), { token: run.token, requestedAt: now() });
    return run;
  });
}

/** Validate all checkpoints before changing any, then skip every possibly sent turn. */
function recoveryPlan(run: Run) {
  const files = readdirSync(run.dir);
  const inputs = files.filter((n) => /^\d+\.in\.md$/.test(n)).sort();
  for (const [i, name] of inputs.entries()) {
    if (i >= 999 || name !== `${String(i + 1).padStart(3, "0")}.in.md`) throw new Error(`Input sequence has a gap or invalid number: ${name}`);
  }
  const statuses = files.filter((n) => /^\d+\.status\.json$/.test(n)).sort().map((name, i) => {
    const number = String(i + 1).padStart(3, "0");
    if (name !== `${number}.status.json` || !inputs.includes(`${number}.in.md`)) throw new Error(`Invalid turn checkpoint sequence: ${name}`);
    const status = readJson(path.join(run.dir, name));
    if (status.number !== number || !["running", "completed", "failed", "aborted", "handled", "interrupted"].includes(status.state))
      throw new Error(`Invalid turn checkpoint: ${name}`);
    return status;
  });
  if (Number(run.lastTurn || 0) > statuses.length || Number(run.currentTurn || 0) > statuses.length)
    throw new Error("Missing execution checkpoint; cannot determine which inputs were sent");
  const session = path.join(run.dir, "session.jsonl");
  if (existsSync(session)) {
    // Do not let a malformed/truncated session silently become a new conversation.
    const records = readFileSync(session, "utf8").split("\n").filter((line) => line.trim());
    try {
      const entries = records.map((line) => JSON.parse(line));
      if (entries[0]?.type !== "session" || !entries[0].id || entries[0].cwd !== run.cwd) throw new Error("Invalid session header or cwd");
    } catch { throw new Error(`Cannot resume damaged session: ${session}; repair it before restart`); }
  } else if (statuses.some((s) => s.entryEnd !== 0 || s.entryStart > 0)) {
    throw new Error(`Session missing: ${session}; cannot restore prior context`);
  }
  return { statuses, pendingTurns: inputs.slice(statuses.length).map((n) => n.slice(0, 3)) };
}

export async function restartRun(dir: string): Promise<Run & { pendingTurns: string[] }> {
  return withRunLock(dir, async () => {
    const inspected = inspectRun(dir);
    if (!["stopped", "failed", "interrupted"].includes(inspected.state)) throw new Error(`Cannot restart run in state ${inspected.state}; stop it first`);
    const run: Run = readJson(path.join(dir, "run.json"));
    const launch = readJson(path.join(dir, "launch.json"), {});
    const claimText = existsSync(path.join(dir, "worker.lock")) ? readFileSync(path.join(dir, "worker.lock"), "utf8").trim() : "";
    const claim = claimText ? JSON.parse(claimText) : {}; // Older worker locks were empty.
    // Heartbeat expiry is not evidence of process exit. Never signal a historical PID.
    const processes = () => processPresent(run.workerPid, run.workerIdentity) || processPresent(run.piPid, run.piIdentity)
      || (launch.token === run.token && processPresent(launch.pid, launch.identity))
      || (claim.token === run.token && processPresent(claim.pid, claim.identity));
    // Terminal metadata can precede the worker's final process exit by a few ms.
    const deadline = Date.now() + 1500;
    while (processes() && Date.now() < deadline) await delay(50);
    if (processes()) throw new Error("Cannot restart: previous worker or Pi process still exists (even if its heartbeat is stale)");
    const { statuses, pendingTurns } = recoveryPlan(run);
    appendFileSync(path.join(dir, "logs", "restarts.jsonl"), JSON.stringify({ at: now(), previous: run, pendingTurns }) + "\n", { mode: 0o600 });
    for (const status of statuses) {
      if (status.state !== "running") continue;
      writeJson(path.join(dir, `${status.number}.status.json`), { ...status, state: "interrupted", endedAt: now(),
        error: "Previous worker exited before confirming completion; not replayed" });
    }
    if (statuses.length) run.lastTurn = statuses.at(-1).number;
    for (const key of ["workerPid", "piPid", "workerIdentity", "piIdentity", "heartbeatAt", "currentTurn", "idleSince", "error", "stopReason"] as const) delete run[key];
    run.config.idleTimeoutMs ??= 86400000;
    run.token = randomUUID();
    run.restartCount = (run.restartCount || 0) + 1;
    run.startedAt = run.updatedAt = now();
    run.state = "starting";
    rmSync(path.join(dir, "stop.json"), { force: true });
    rmSync(path.join(dir, "worker.lock"), { force: true });
    writeJson(path.join(dir, "run.json"), run);
    return { ...await launchWorker(run), pendingTurns };
  });
}
