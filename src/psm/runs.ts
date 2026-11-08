import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { psmHome } from "./config.ts";
import type { Config, ModelChoice } from "./config.ts";
import { processPresent } from "./control.ts";
import { readJson } from "./files.ts";

export interface Run {
  schema: 1;
  id: string;
  token: string;
  dir: string;
  cwd: string;
  group: string;
  model: ModelChoice;
  config: Config;
  state: "starting" | "idle" | "running" | "stopping" | "stopped" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  idleSince?: string;
  stopReason?: "requested" | "signal" | "idle_timeout" | "error";
  restartCount?: number;
  workerIdentity?: string;
  piIdentity?: string;
  heartbeatAt?: string;
  workerPid?: number;
  piPid?: number;
  currentTurn?: string;
  lastTurn?: string;
  error?: string;
  archiveError?: string;
}

export function alive(run: Run): boolean {
  if (!["starting", "idle", "running", "stopping"].includes(run.state) || !run.workerPid || !run.heartbeatAt) return false;
  if (Date.now() - Date.parse(run.heartbeatAt) > Math.max(10000, run.config.pollMs * 4)) return false;
  return processPresent(run.workerPid, run.workerIdentity);
}

export function inspectRun(dir: string): Run & { alive: boolean; lastTurnStatus?: Record<string, any> } {
  const run: Run = readJson(path.join(dir, "run.json"));
  const living = alive(run);
  // Leave a brief startup grace period before calling a not-yet-started worker interrupted.
  const startupGrace = run.state === "starting" && Date.now() - Date.parse(run.startedAt || run.createdAt) < run.config.startupTimeoutMs;
  const lastTurnStatus = run.lastTurn ? readJson(path.join(dir, `${run.lastTurn}.status.json`), null) : undefined;
  return { ...run, ...(lastTurnStatus ? { lastTurnStatus } : {}), state: !living && !startupGrace && ["starting", "idle", "running", "stopping"].includes(run.state) ? "interrupted" : run.state, alive: living };
}

export function listRuns(home = psmHome(), all = false): ReturnType<typeof inspectRun>[] {
  const registry = path.join(home, "registry");
  if (!existsSync(registry)) return [];
  const runs = [];
  for (const entry of readdirSync(registry)) {
    if (!entry.endsWith(".json")) continue;
    const pointer = readJson(path.join(registry, entry));
    if (!existsSync(path.join(pointer.dir, "run.json"))) continue;
    const run = inspectRun(pointer.dir);
    if (run.id !== pointer.id) throw new Error(`Registry identity mismatch: ${entry}`);
    if (all || run.alive || Date.now() - Date.parse(run.updatedAt) <= 86400000) runs.push(run);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Permanent atomic reservations survive failed starts and deleted run directories. */
export function allocateRunId(home = psmHome()): string {
  const reservations = path.join(home, "ids");
  mkdirSync(reservations, { recursive: true, mode: 0o700 });
  const registry = path.join(home, "registry");
  const names = [...readdirSync(reservations), ...(existsSync(registry) ? readdirSync(registry).map((n) => n.replace(/\.json$/, "")) : [])];
  let highest = 0;
  for (const name of names) if (/^\d{6}$/.test(name)) highest = Math.max(highest, Number(name));
  for (let number = highest + 1; number <= 999999; number++) {
    const id = String(number).padStart(6, "0");
    try { mkdirSync(path.join(reservations, id), { mode: 0o700 }); return id; }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  throw new Error("Run ID limit reached (999999)");
}

export function findRun(id: string, home = psmHome()): ReturnType<typeof inspectRun> {
  const numeric = /^\d+$/.test(id);
  if (numeric) {
    if (!/^\d{1,6}$/.test(id) || Number(id) < 1) throw new Error(`Invalid run ID: ${id}`);
    id = String(Number(id)).padStart(6, "0");
  }
  const runs = listRuns(home, true);
  const exact = runs.find((run) => run.id === id);
  if (exact) return exact;
  if (numeric) throw new Error(`Run not found: ${id}`);
  const matches = runs.filter((run) => run.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous run ID: ${id}` : `Run not found: ${id}`);
  return matches[0];
}
