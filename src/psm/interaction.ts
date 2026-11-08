import { existsSync, linkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWrite, delay } from "./files.ts";
import { inspectRun } from "./runs.ts";

/** Serialize CLI publishers; hard-link publication refuses to overwrite manual input. */
export async function submitPrompt(dir: string, text: string): Promise<{ number: string; input: string; output: string }> {
  if (!text.trim()) throw new Error("Prompt must not be empty");
  const lock = path.join(dir, "prompt.lock");
  const deadline = Date.now() + 5000;
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Prompt submission is locked: ${lock}; check for an interrupted publisher`);
      await delay(25);
    }
  }
  const temporary = path.join(dir, `.prompt-${randomUUID()}.tmp`);
  try {
    const run = inspectRun(dir);
    if (!run.alive || !["idle", "running"].includes(run.state) || existsSync(path.join(dir, "stop.json")))
      throw new Error(`Cannot submit prompt to run in state ${run.state} or pending shutdown`);
    const names = readdirSync(dir).filter((n) => /^\d+\.in\.md$/.test(n)).sort();
    for (const [i, name] of names.entries()) {
      if (name !== `${String(i + 1).padStart(3, "0")}.in.md`) throw new Error(`Input sequence has a gap or invalid number: ${name}`);
    }
    const next = Math.max(names.length, Number(run.currentTurn || run.lastTurn || 0)) + 1;
    if (next > 999) throw new Error("Turn limit reached (999)");
    const number = String(next).padStart(3, "0");
    const input = path.join(dir, `${number}.in.md`);
    const output = path.join(dir, `${number}.out.md`);
    if (existsSync(output) || existsSync(path.join(dir, `${number}.status.json`))) throw new Error(`Turn ${number} already exists`);
    atomicWrite(temporary, text);
    linkSync(temporary, input);
    return { number, input, output };
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true });
  }
}

export function archiveFile(dir: string, level = "l1"): string {
  if (!["l1", "l3"].includes(level)) throw new Error("Archive level must be l1 or l3");
  const file = path.join(dir, `session.${level}.md`);
  if (!existsSync(file)) throw new Error(`Archive not available yet: ${file}; wait for a turn to finish`);
  return file;
}
