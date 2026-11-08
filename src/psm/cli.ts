#!/usr/bin/env node
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, selectModel } from "./config.ts";
import { atomicWrite, delay, now, writeJson } from "./files.ts";
import { formatRuns } from "./table.ts";
import { openFile } from "../open.ts";
import { archiveFile, submitPrompt } from "./interaction.ts";
import { allocateRunId, findRun, inspectRun, listRuns, type Run } from "./runs.ts";

const usage = `psm — file-driven background Pi sessions (Pi >= 1.5; Linux/WSL/macOS)

  psm <model-alias> <first-prompt> [--group <name>]
  psm <first-prompt>                 Use config.defaultModel
  psm list [--all] [--group <name>] [--json]
  psm status <run-id>                JSON status; numeric IDs accept shorthand (1 = 000001)
  psm open <run-id> [--level l1|l3]   Open archive using the garden system opener
  psm prompt <run-id> <text>         Submit the next turn (queued while running)
  psm prompt <run-id> --file <path>   Read a UTF-8 prompt file
  psm stop <run-id>                  Request shutdown and wait up to 10 seconds

Quote each prompt as one argument; use -- before a prompt starting with '-'.
Configure ~/.psm/config.json and ./.psm/config.json (local overrides global).
Create 002.in.md, 003.in.md, ... in the returned directory for subsequent turns.
Publish inputs by renaming a temporary file. Completed replies appear as NNN.out.md.
`;

export async function startRun(cwd: string, prompt: string, alias?: string, group = "default"): Promise<Run> {
  if (process.platform === "win32") throw new Error("Native Windows is not supported yet; use WSL");
  if (!prompt.trim()) throw new Error("First prompt must not be empty");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(group)) throw new Error("Group must use 1–64 letters, numbers, '_' or '-'");
  const loaded = loadConfig(cwd);
  const model = selectModel(loaded.config, alias);
  const id = allocateRunId(loaded.home);
  const dir = path.join(loaded.local, "runs", group, id);
  const agent = path.join(dir, "agent");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  if (loaded.modelsFile) symlinkSync(loaded.modelsFile, path.join(agent, "models.json"));
  mkdirSync(path.join(dir, "logs"), { mode: 0o700 });
  writeJson(path.join(agent, "auth.json"), loaded.auth);
  writeJson(path.join(agent, "settings.json"), { packages: [], quietStartup: true });
  const run: Run = { schema: 1, id, token: randomUUID(), dir, cwd, group, model, config: loaded.config,
    state: "starting", createdAt: now(), updatedAt: now() };
  writeJson(path.join(dir, "run.json"), run);
  atomicWrite(path.join(dir, "001.in.md"), prompt);
  writeJson(path.join(loaded.home, "registry", `${id}.json`), { id, dir });
  const log = openSync(path.join(dir, "logs", "stderr.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.ts", import.meta.url)), dir], {
      cwd, detached: true, stdio: ["ignore", log, log], env: process.env,
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  } catch (error: any) {
    run.state = "failed"; run.error = error.message; run.updatedAt = now();
    writeJson(path.join(dir, "run.json"), run);
    throw new Error(`Worker startup failed: ${error.message}; run directory: ${dir}`);
  } finally { closeSync(log); }
  const deadline = Date.now() + loaded.config.startupTimeoutMs + 2000;
  while (Date.now() < deadline) {
    const latest = inspectRun(dir);
    if (latest.state === "idle" || latest.state === "running") return latest;
    if (["failed", "stopped", "interrupted"].includes(latest.state)) throw new Error(`${latest.error || latest.state}; run directory: ${dir}`);
    await delay(100);
  }
  writeJson(path.join(dir, "stop.json"), { token: run.token, requestedAt: now() });
  throw new Error(`Startup timed out; shutdown requested. Inspect ${dir}/logs/stderr.log`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: "string" }, level: { type: "string" },
    help: { type: "boolean", short: "h" }, all: { type: "boolean" }, json: { type: "boolean" }, group: { type: "string" },
  } });
  if (values.help || !positionals.length) { console.log(usage); return; }
  const [command, ...rest] = positionals;
  if (values.file !== undefined && command !== "prompt") throw new Error("--file is for prompt");
  if (values.level !== undefined && command !== "open") throw new Error("--level is for open");
  if (command === "open" || command === "prompt") {
    if (values.all || values.group || values.json && command === "open") throw new Error(`Unsupported option for ${command}`);
    if (command === "open") {
      if (rest.length !== 1) throw new Error("Usage: psm open <run-id> [--level l1|l3]");
      const run = findRun(rest[0]);
      const file = archiveFile(run.dir, values.level);
      const result = await openFile(file);
      if (!result.ok) throw new Error(result.detail);
      console.log(`Opened: ${file}`);
    } else {
      if (values.file !== undefined ? rest.length !== 1 : rest.length !== 2)
        throw new Error("Usage: psm prompt <run-id> <text> OR psm prompt <run-id> --file <path>");
      const run = findRun(rest[0]);
      const text = values.file !== undefined ? readFileSync(path.resolve(values.file), "utf8") : rest[1];
      const result = await submitPrompt(run.dir, text);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Run: ${run.id}\nTurn: ${result.number}\nInput: ${result.input}\nReply: ${result.output}`);
    }
    return;
  }
  if (command === "list") {
    if (rest.length) throw new Error("Usage: psm list [--all] [--group name] [--json]");
    const runs = listRuns(undefined, values.all).filter((run) => !values.group || run.group === values.group);
    if (values.json) console.log(JSON.stringify(runs, null, 2));
    else console.log(formatRuns(runs, process.stdout.columns || 120));
    return;
  }
  if (values.all || values.group && ["status", "stop"].includes(command)) throw new Error("--all is for list; --group is for start/list");
  if (command === "status" || command === "stop") {
    if (rest.length !== 1) throw new Error(`Usage: psm ${command} <run-id>`);
    const run = findRun(rest[0]);
    if (command === "status") { console.log(JSON.stringify(run, null, 2)); return; }
    if (!run.alive && run.state !== "starting") { console.log(JSON.stringify(run, null, 2)); return; }
    writeJson(path.join(run.dir, "stop.json"), { token: run.token, requestedAt: now() });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const latest = inspectRun(run.dir);
      if (["stopped", "failed", "interrupted"].includes(latest.state)) { console.log(JSON.stringify(latest, null, 2)); return; }
      await delay(100);
    }
    throw new Error(`Stop requested but not yet confirmed; use psm status ${run.id}`);
  }
  if (positionals.length > 2) throw new Error("Quote the prompt as a single argument");
  const run = await startRun(process.cwd(), positionals.at(-1)!, positionals.length === 2 ? command : undefined, values.group);
  if (values.json) console.log(JSON.stringify(run, null, 2));
  else console.log(`Run: ${run.id}\nState: ${run.state}\nDirectory: ${run.dir}\nReply: ${path.join(run.dir, "001.out.md")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(`psm: ${error.message}`); process.exitCode = 1; });
}
