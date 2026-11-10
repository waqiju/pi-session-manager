#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listPipelines, loadPipeline, preparePipeline, type Pipeline } from "./pipeline.ts";
import { listModels } from "./models.ts";
import { psmHome, loadConfig, selectModel } from "./config.ts";
import { atomicWrite, delay, now, writeJson } from "./files.ts";
import { formatRuns } from "./table.ts";
import { openFile } from "../open.ts";
import { launchWorker, requestStop, restartRun } from "./lifecycle.ts";
import { waitForTurn } from "./wait.ts";
import { followLogs } from "./logs.ts";
import { archiveFile, submitPrompt } from "./interaction.ts";
import { allocateRunId, findRun, inspectRun, listRuns, type Run } from "./runs.ts";

const usage = `psm — file-driven background Pi sessions (Pi >= 1.5; Linux/WSL/macOS)

  psm <model-expression> <first-prompt> [--group <name>]
  psm <first-prompt>                 Use config.defaultModel
  psm run <pipeline> <first-prompt> [--group <name>] [--json]
  psm run <pipeline> --file <path>   Run .psm/pipelines/<pipeline>/pipeline.mjs (local, then global)
  psm models [search]               List available models using PSM configuration
  psm pipelines [--json]            List pipelines without executing their JS
  psm list [--all] [--group <name>] [--json]
  psm status <run-id>                JSON status; numeric IDs accept shorthand (1 = 000001)
  psm open <run-id> [--level l1|l3]   Open archive (default L3) using the garden system opener
  psm <numeric-id> <text>            Shorthand for psm prompt <id> <text>
  psm <numeric-id> --file <path>     Submit a UTF-8 prompt file
  psm logs <run-id> [--format text|json] [--lines 100] [--no-follow]
  psm prompt <run-id> <text>         Submit the next turn (queued while running)
  psm prompt <run-id> --file <path>   Read a UTF-8 prompt file
  psm wait <run-id> [--turn <number>] [--timeout <seconds>] [--json]
  psm stop <run-id>                  Request shutdown and wait up to 10 seconds
  psm restart <run-id> [--json]      Restart worker, resume session; never replay interrupted turns

Wait pins the latest submitted turn unless --turn is given; timeout/Ctrl+C only exit the waiter.
Logs default to text and follow; --lines counts source event lines. Ctrl+C exits only the viewer.
Quote each prompt as one argument; use -- before a prompt starting with '-'.
Configure ~/.psm/config.json and ./.psm/config.json (local overrides global).
Create 002.in.md, 003.in.md, ... in the returned directory for subsequent turns.
Publish inputs by renaming a temporary file. Completed replies appear as NNN.out.md.
`;

export async function startPipeline(cwd: string, name: string, prompt: string, group?: string): Promise<Run> {
  const pipeline = await loadPipeline(cwd, loadConfig(cwd).home, name);
  return startRun(cwd, prompt, pipeline.model, group ?? pipeline.group ?? "default", pipeline);
}

export async function startRun(cwd: string, prompt: string, modelExpression?: string, group = "default", pipeline?: Pipeline): Promise<Run> {
  if (process.platform === "win32") throw new Error("Native Windows is not supported yet; use WSL");
  if (!prompt.trim()) throw new Error("First prompt must not be empty");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(group)) throw new Error("Group must use 1–64 letters, numbers, '_' or '-'");
  const loaded = loadConfig(cwd);
  if (pipeline) loaded.config = { ...loaded.config, ...pipeline.config };
  const requestedModel = selectModel(loaded.config, modelExpression);
  const id = allocateRunId(loaded.home);
  const dir = path.join(loaded.local, "runs", group, id);
  const agent = path.join(dir, "agent");
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  if (loaded.modelsFile) symlinkSync(loaded.modelsFile, path.join(agent, "models.json"));
  mkdirSync(path.join(dir, "logs"), { mode: 0o700 });
  writeJson(path.join(agent, "auth.json"), loaded.auth);
  writeJson(path.join(agent, "settings.json"), { packages: [], quietStartup: true });
  if (pipeline) preparePipeline(pipeline, agent, cwd);
  const run: Run = { schema: 1, id, token: randomUUID(), dir, cwd, group, requestedModel, config: loaded.config,
    ...(pipeline ? { pipeline } : {}),
    state: "starting", createdAt: now(), startedAt: now(), updatedAt: now(), restartCount: 0 };
  writeJson(path.join(dir, "run.json"), run);
  atomicWrite(path.join(dir, "001.in.md"), prompt);
  // Initialize before publishing the run or spawning its sole archive writer.
  // Pi owns session.jsonl; this waiting document is not a synthetic session.
  const initialArchive = `# PSM run ${id}\n\n> Waiting for the first turn result. PSM replaces this document when the turn ends.\n> Check \`psm status ${id}\` for run status.\n\n## First prompt\n\n${prompt}\n`;
  for (const level of ["l1", "l3"]) {
    atomicWrite(path.join(dir, `session.${level}.md`), initialArchive);
  }
  writeJson(path.join(loaded.home, "registry", `${id}.json`), { id, dir });
  return launchWorker(run);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    format: { type: "string" }, lines: { type: "string" }, "no-follow": { type: "boolean" },
    file: { type: "string" }, level: { type: "string" },
    turn: { type: "string" }, timeout: { type: "string" },
    help: { type: "boolean", short: "h" }, all: { type: "boolean" }, json: { type: "boolean" }, group: { type: "string" },
  } });
  if (values.help || !positionals.length) { console.log(usage); return; }
  let [command, ...rest] = positionals;
  if (/^\d+$/.test(command) && (rest.length > 0 || values.file !== undefined)) {
    rest = [command, ...rest];
    command = "prompt";
  }
  if (command !== "logs" && (values.format !== undefined || values.lines !== undefined || values["no-follow"]))
    throw new Error("--format, --lines and --no-follow are for logs");
  if (values.file !== undefined && !["prompt", "run"].includes(command)) throw new Error("--file is for prompt/run");
  if (values.level !== undefined && command !== "open") throw new Error("--level is for open");
  if (command !== "wait" && (values.turn !== undefined || values.timeout !== undefined))
    throw new Error("--turn and --timeout are for wait");
  if (command === "wait") {
    if (rest.length !== 1 || values.all || values.group) throw new Error("Usage: psm wait <run-id> [--turn <number>] [--timeout <seconds>] [--json]");
    if (values.timeout !== undefined && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(values.timeout))
      throw new Error("--timeout must be a positive number of seconds");
    const run = findRun(rest[0]);
    const controller = new AbortController();
    let signalCode = 130;
    const interrupt = () => { signalCode = 130; controller.abort(); };
    const terminate = () => { signalCode = 143; controller.abort(); };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      const result = await waitForTurn(run.dir, { turn: values.turn,
        timeoutSeconds: values.timeout === undefined ? undefined : Number(values.timeout), signal: controller.signal });
      if (result.state === "cancelled") result.exitCode = signalCode;
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Run: ${result.id}\nTurn: ${result.number}\nState: ${result.state}${result.output ? `\nReply: ${result.output}` : ""}`);
        if (result.state === "handled") console.log("Handled by extension; no model reply.");
        if (result.error) console.error(result.error);
      }
      process.exitCode = result.exitCode;
    } finally {
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
    }
    return;
  }
  if (command === "models") {
    if (rest.length > 1 || values.all || values.group || values.json) throw new Error("Usage: psm models [search]");
    process.stdout.write(await listModels(process.cwd(), rest[0]));
    return;
  }
  if (command === "pipelines") {
    if (rest.length || values.all || values.group) throw new Error("Usage: psm pipelines [--json]");
    const pipelines = listPipelines(process.cwd(), psmHome());
    if (values.json) console.log(JSON.stringify(pipelines, null, 2));
    else if (!pipelines.length) console.log("No pipelines found. Add .psm/pipelines/<name>/pipeline.mjs or a global PSM pipeline.");
    else {
      const width = Math.max(4, ...pipelines.map((p) => p.name.length));
      console.log(`${"NAME".padEnd(width)}  SCOPE   ENTRY    PATH`);
      for (const p of pipelines) console.log(`${p.name.padEnd(width)}  ${p.scope.padEnd(6)}  ${(p.entryExists ? "present" : "missing").padEnd(7)}  ${p.file}`);
      console.log("Entry presence only; JS is not executed or validated. Local entries override global entries.");
    }
    return;
  }
  if (command === "run") {
    if (values.all || (values.file !== undefined ? rest.length !== 1 : rest.length !== 2))
      throw new Error("Usage: psm run <pipeline> <text> OR psm run <pipeline> --file <path> [--group <name>] [--json]");
    const prompt = values.file !== undefined ? readFileSync(path.resolve(values.file), "utf8") : rest[1];
    const run = await startPipeline(process.cwd(), rest[0], prompt, values.group);
    printStarted(run, !!values.json);
    return;
  }
  if (command === "logs") {
    if (rest.length !== 1 || values.all || values.group || values.json) throw new Error("Usage: psm logs <run-id> [--format text|json] [--lines 100] [--no-follow]");
    const format = values.format ?? "text";
    if (format !== "text" && format !== "json") throw new Error("Log format must be text or json");
    const lines = values.lines ?? "100";
    if (!/^\d+$/.test(lines) || !Number.isSafeInteger(Number(lines))) throw new Error("--lines must be a non-negative safe integer");
    const run = findRun(rest[0]);
    const controller = new AbortController();
    const stop = () => controller.abort();
    const stdoutError = (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") stop(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdout.on("error", stdoutError);
    try {
      await followLogs(run.dir, { format, lines: Number(lines), follow: !values["no-follow"], signal: controller.signal,
        write: (text) => new Promise<void>((resolve, reject) => process.stdout.write(text, (error) => error ? reject(error) : resolve())),
        diagnostic: (text) => process.stderr.write(text),
      });
    } catch (error: any) { if (error.code !== "EPIPE") throw error; }
    finally {
      process.off("SIGINT", stop); process.off("SIGTERM", stop); process.stdout.off("error", stdoutError);
    }
    return;
  }
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
  if (command === "restart") {
    if (rest.length !== 1 || values.all || values.group) throw new Error("Usage: psm restart <run-id> [--json]");
    const run = await restartRun(findRun(rest[0]).dir);
    if (values.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`Run: ${run.id}\nState: ${run.state}\nDirectory: ${run.dir}\nRestart count: ${run.restartCount}\nPending turns at restart: ${run.pendingTurns.join(", ") || "none"}\nInterrupted turns are not replayed.`);
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
    const requested = await requestStop(run.dir);
    if (!requested.alive && requested.state !== "starting") { console.log(JSON.stringify(requested, null, 2)); return; }
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
  printStarted(run, !!values.json);
}

function printStarted(run: Run, json: boolean): void {
  if (json) console.log(JSON.stringify(run, null, 2));
  else console.log(`Run: ${run.id}\nState: ${run.state}\n${run.pipeline ? `Pipeline: ${run.pipeline.name} (${run.pipeline.resources})\n` : ""}Model: ${run.model?.provider}/${run.model?.model} (thinking: ${run.model?.thinking ?? "unknown"})\nDirectory: ${run.dir}\nReply: ${path.join(run.dir, "001.out.md")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(`psm: ${error.message}`); process.exitCode = 1; });
}
