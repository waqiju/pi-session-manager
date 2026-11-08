import { appendFileSync, closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { archiveSession } from "../archive.ts";
import { atomicWrite, delay, now, readJson, writeJson } from "./files.ts";
import { Rpc, RpcRejection, type RecordValue } from "./rpc.ts";
import type { Run } from "./runs.ts";

interface Turn {
  number: string;
  hash: string;
  startedAt: string;
  text: string;
  error?: string;
  aborted?: boolean;
}

export async function work(dir: string): Promise<void> {
  const runPath = path.join(dir, "run.json");
  const run: Run = readJson(runPath);
  // Workers are not restartable: an interrupted prompt may already have side effects.
  if (run.state !== "starting" || run.workerPid) throw new Error("Run has already been claimed; automatic replay is disabled");
  closeSync(openSync(path.join(dir, "worker.lock"), "wx", 0o600));
  let current: Turn | undefined;
  let stopping = false;
  let fatal: string | undefined;
  let rpc: Rpc | undefined;
  const seen = new Map<string, { hash: string; since: number }>();
  const persist = () => { run.heartbeatAt = now(); writeJson(runPath, run); };
  const transition = (state: Run["state"]) => { run.state = state; run.updatedAt = now(); persist(); };
  const log = (text: string) => appendFileSync(path.join(dir, "stderr.log"), text, { mode: 0o600 });
  const archive = () => {
    if (!existsSync(path.join(dir, "session.jsonl"))) return;
    try { archiveSession(path.join(dir, "session.jsonl"), path.join(dir, "session")); delete run.archiveError; }
    catch (error: any) { run.archiveError = error.message; log(`Archive: ${error.message}\n`); }
  };
  const finish = (state: string, error?: string) => {
    if (!current) return;
    const turn = current;
    if (state === "completed") atomicWrite(path.join(dir, `${turn.number}.out`), turn.text);
    writeJson(path.join(dir, `${turn.number}.status.json`), {
      number: turn.number, inputHash: turn.hash, state, startedAt: turn.startedAt, endedAt: now(), ...(error ? { error } : {}),
    });
    current = undefined;
    run.lastTurn = turn.number;
    delete run.currentTurn;
    archive();
    if (!stopping) transition("idle");
  };
  const event = (record: RecordValue) => {
    appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
      void rpc?.send({ type: "extension_ui_response", id: record.id, cancelled: true }).catch((e) => { fatal = e.message; });
    }
    if (!current) return;
    if (record.type === "message_end" && record.message?.role === "assistant") {
      const message = record.message;
      current.text = (message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      current.error = message.stopReason === "error" ? message.errorMessage || "Model request failed" : undefined;
      current.aborted = message.stopReason === "aborted";
    }
    if (record.type === "auto_retry_end" && record.success === false) current.error = record.finalError || "Retries exhausted";
    if (record.type === "agent_settled") {
      const error = current.error;
      finish(record.aborted || current.aborted ? "aborted" : error ? "failed" : "completed", error);
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Unblock startup/acceptance waits too, not only the idle polling loop.
    rpc?.fail(new Error("Shutdown requested"));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  run.workerPid = process.pid;
  persist();
  // Heartbeats continue while waiting for the startup RPC response.
  const heartbeat = setInterval(() => {
    try {
      persist();
      if (existsSync(path.join(dir, "stop.json")) && readJson(path.join(dir, "stop.json")).token === run.token) stop();
    } catch (e: any) { fatal = e.message; rpc?.fail(e); }
  }, 1000);
  try {
    const agent = path.join(dir, "agent");
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: dir, PI_GARDEN: "0" };
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    const command = [...run.config.piCommand, "--mode", "rpc", "--session", path.join(dir, "session.jsonl"),
      "--session-dir", dir, "--provider", run.model.provider, "--model", run.model.model,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-approve", "--offline"];
    if (run.model.thinking) command.push("--thinking", run.model.thinking);
    rpc = new Rpc(command, { cwd: run.cwd, env, log, event });
    rpc.onFailure = (error) => { if (!stopping) fatal = error.message; };
    run.piPid = rpc.child.pid;
    persist();
    const state = await rpc.request("get_state", {}, run.config.startupTimeoutMs);
    if (state?.model?.id !== run.model.model || state?.model?.provider !== run.model.provider)
      throw new Error("Pi selected a different model; exact provider/model match required");
    transition("idle");
    while (!stopping && !fatal) {
      if (existsSync(path.join(dir, "stop.json"))) {
        if (readJson(path.join(dir, "stop.json")).token === run.token) { stopping = true; break; }
      }
      if (current && Date.now() - Date.parse(current.startedAt) > run.config.turnTimeoutMs) {
        fatal = "Turn deadline exceeded; outcome unknown, not replayed";
        break;
      }
      if (!current) {
        const names = readdirSync(dir).filter((name) => /^\d+\.in$/.test(name)).sort();
        for (const name of names) {
          if (!/^(?!000)\d{3}\.in$/.test(name)) throw new Error(`Invalid input number: ${name}; use 001.in through 999.in`);
        }
        const next = String(Number(run.lastTurn || 0) + 1).padStart(3, "0");
        const name = `${next}.in`;
        if (names.includes(name)) {
          const file = path.join(dir, name);
          if (!lstatSync(file).isFile()) throw new Error(`Input must be a regular file: ${name}`);
          if (existsSync(path.join(dir, `${next}.status.json`))) throw new Error(`Input ${next} already has execution state; refusing replay`);
          const text = readFileSync(file, "utf8");
          const hash = createHash("sha256").update(text).digest("hex");
          const previous = seen.get(name);
          if (!previous || previous.hash !== hash) seen.set(name, { hash, since: Date.now() });
          else if (text.trim() && Date.now() - previous.since >= run.config.stableMs) {
            current = { number: next, hash, startedAt: now(), text: "" };
            writeJson(path.join(dir, `${next}.status.json`), { number: next, inputHash: hash, state: "running", startedAt: current.startedAt });
            run.currentTurn = next;
            transition("running");
            // The listener is already installed: fast message_end/settled may precede this response.
            try {
              const response = await rpc.request("prompt", { message: text }, run.config.startupTimeoutMs);
              if (response?.disposition === "handled") finish("handled");
              else if (response?.disposition !== "started") throw new Error(`Unexpected prompt disposition: ${response?.disposition}`);
            } catch (error) {
              if (error instanceof RpcRejection) finish("failed", error.message);
              else throw error;
            }
          }
        }
      }
      await delay(run.config.pollMs);
    }
  } catch (error: any) { if (!stopping) fatal = error.message; }
  finally {
    stopping = true;
    transition("stopping");
    if (current) finish("interrupted", fatal || "Stopped; prompt may have partially executed");
    await rpc?.close();
    archive();
    if (fatal) { run.error = fatal; log(`${fatal}\n`); }
    transition(fatal ? "failed" : "stopped");
    clearInterval(heartbeat);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  work(path.resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
