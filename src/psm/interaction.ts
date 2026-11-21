import { existsSync, linkSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWrite, now, writeJson } from "./files.ts";
import { launchWorker } from "./lifecycle.ts";
import { checkPipeline } from "./pipeline.ts";
import { withRunLock } from "./control.ts";
import { inspectRun } from "./runs.ts";

/** Serialize CLI publishers; hard-link publication refuses to overwrite manual input. */
export async function submitPrompt(dir: string, text: string): Promise<{ number: string; input: string; output: string }> {
  if (!text.trim()) throw new Error("Prompt must not be empty");
  return withRunLock(dir, async () => {
    const temporary = path.join(dir, `.prompt-${randomUUID()}.tmp`);
    try {
      const run = inspectRun(dir);
      const initializing = run.state === "initialized";
      if ((!initializing && (!run.alive || !["idle", "running"].includes(run.state))) || existsSync(path.join(dir, "stop.json")))
        throw new Error(`Cannot submit prompt to run in state ${run.state} or pending shutdown`);
      if (initializing) checkPipeline(run.pipeline);
      const names = readdirSync(dir).filter((n) => /^\d+\.in\.md$/.test(n)).sort();
      if (initializing && (names.length || run.currentTurn || run.lastTurn))
        throw new Error("Initialized run already contains turn inputs; submit the first prompt through psm prompt, not manual input files");
      for (const [i, name] of names.entries()) {
        if (name !== `${String(i + 1).padStart(3, "0")}.in.md`) throw new Error(`Input sequence has a gap or invalid number: ${name}`);
      }
      const next = Math.max(names.length, Number(run.currentTurn || run.lastTurn || 0)) + 1;
      if (next > 999) throw new Error("Turn limit reached (999)");
      const number = String(next).padStart(3, "0");
      const input = path.join(dir, `${number}.in.md`);
      const output = path.join(dir, `${number}.out.md`);
      if (existsSync(output) || existsSync(path.join(dir, `${number}.status.json`))) throw new Error(`Turn ${number} already exists`);
      if (initializing) {
        // Pi owns session.jsonl. Publish only reading placeholders before starting its archive writer.
        const archive = `# PSM run ${run.id}\n\n> Waiting for the first turn result. PSM replaces this document when the turn ends.\n> Check \`psm status ${run.id}\` for run status.\n\n## First prompt\n\n${text}\n`;
        for (const level of ["l1", "l3"]) atomicWrite(path.join(dir, `session.${level}.md`), archive);
      }
      atomicWrite(temporary, text);
      linkSync(temporary, input);
      if (initializing) {
        const { alive, lastTurnStatus, ...saved } = run;
        saved.state = "starting";
        saved.startedAt = saved.updatedAt = now();
        writeJson(path.join(dir, "run.json"), saved);
        await launchWorker(saved);
      }
      return { number, input, output };
    } finally {
      rmSync(temporary, { force: true });
    }
  });
}

export function archiveFile(dir: string, level = "l3"): string {
  if (!["l1", "l3"].includes(level)) throw new Error("Archive level must be l1 or l3");
  const file = path.join(dir, `session.${level}.md`);
  if (!existsSync(file)) throw new Error(`Archive not available yet: ${file}; wait for a turn to finish`);
  return file;
}
