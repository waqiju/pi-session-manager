import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { psmHome } from "./config.ts";
import type { Config, ModelChoice } from "./config.ts";
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
  try { process.kill(run.workerPid, 0); return true; } catch { return false; }
}

export function inspectRun(dir: string): Run & { alive: boolean } {
  const run: Run = readJson(path.join(dir, "run.json"));
  const living = alive(run);
  // Leave a brief startup grace period before calling a not-yet-started worker interrupted.
  const startupGrace = run.state === "starting" && Date.now() - Date.parse(run.createdAt) < run.config.startupTimeoutMs;
  return { ...run, state: !living && !startupGrace && ["starting", "idle", "running", "stopping"].includes(run.state) ? "interrupted" : run.state, alive: living };
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

export function findRun(id: string, home = psmHome()): ReturnType<typeof inspectRun> {
  const matches = listRuns(home, true).filter((run) => run.id === id || run.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous run ID: ${id}` : `Run not found: ${id}`);
  return matches[0];
}
