import { readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { readJson } from "./files.ts";
import { inspectRun } from "./runs.ts";

export interface WaitResult {
  id: string;
  number: string;
  state: "completed" | "handled" | "failed" | "aborted" | "interrupted" | "unavailable" | "timeout" | "cancelled";
  input: string;
  output?: string;
  error?: string;
  exitCode: number;
}

/** Observe one immutable target; never stop, restart, or modify the run. */
export async function waitForTurn(dir: string, options: {
  turn?: string; timeoutSeconds?: number; signal?: AbortSignal;
} = {}): Promise<WaitResult> {
  if (options.turn !== undefined && (!/^\d{1,3}$/.test(options.turn) || Number(options.turn) < 1))
    throw new Error("--turn must be an integer from 1 through 999");
  if (options.timeoutSeconds !== undefined && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0))
    throw new Error("--timeout must be a positive number of seconds");
  const started = performance.now();
  const deadline = options.timeoutSeconds === undefined ? Infinity : started + options.timeoutSeconds * 1000;
  const submitted = readdirSync(dir).filter((name) => /^(?!000)\d{3}\.in\.md$/.test(name)).sort();
  const number = options.turn === undefined ? submitted.at(-1)?.slice(0, 3) : options.turn.padStart(3, "0");
  if (!number || !submitted.includes(`${number}.in.md`)) throw new Error(`Submitted turn not found: ${number ?? "none"}`);
  const base = { id: path.basename(dir), number, input: path.join(dir, `${number}.in.md`) };
  const statusPath = path.join(dir, `${number}.status.json`);
  const runPath = path.join(dir, "run.json");
  const terminal = (): WaitResult | undefined => {
    const status = readJson(statusPath, null);
    if (!status) return;
    if (status.number !== number) throw new Error(`Turn identity mismatch: ${statusPath}`);
    if (status.state === "running") return;
    if (!["completed", "handled", "failed", "aborted", "interrupted"].includes(status.state))
      throw new Error(`Invalid turn state: ${statusPath}`);
    return { ...base, state: status.state, exitCode: ["completed", "handled"].includes(status.state) ? 0 : 1,
      ...(status.state === "completed" ? { output: path.join(dir, `${number}.out.md`) } : {}),
      ...(status.error ? { error: status.error } : {}) };
  };
  let missingSince: number | undefined;
  while (true) {
    if (options.signal?.aborted) return { ...base, state: "cancelled", exitCode: 130, error: "Waiting cancelled; background run was not stopped" };
    const result = terminal();
    if (result) return result;
    try {
      const run = inspectRun(dir);
      missingSince = undefined;
      if (["stopped", "failed", "interrupted"].includes(run.state)) {
        // Completion can be published between the first status read and the run read.
        const finished = terminal();
        if (finished) return finished;
        return { ...base, state: "unavailable", exitCode: 1,
          error: `Run ${run.id} is ${run.state}; turn ${number} has not completed${run.error ? `: ${run.error}` : ""}` };
      }
    } catch (error: any) {
      if (error.cause?.code !== "ENOENT" || error.cause?.path !== runPath) throw error;
      missingSince ??= performance.now();
      if (performance.now() - missingSince >= 2000)
        throw new Error(`Run metadata unavailable for 2 seconds: ${runPath}`, { cause: error });
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { ...base, state: "timeout", exitCode: 124, error: "Wait timed out; background run was not stopped" };
    try { await pause(Math.min(500, remaining), undefined, { signal: options.signal }); }
    catch (error: any) { if (error.name !== "AbortError") throw error; }
  }
}
