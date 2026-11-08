import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { archiveSession } from "../archive.ts";
import { parseSessionFile } from "../parser.ts";
import { refreshReplyDetails, replyDocument } from "./replies.ts";
import { atomicWrite, delay, now, readJson, writeJson } from "./files.ts";
import { Rpc, RpcRejection, type RecordValue } from "./rpc.ts";
import { processIdentity, tryRunLock } from "./control.ts";
import { checkPipeline, pipelineArgs } from "./pipeline.ts";
import type { Run } from "./runs.ts";

interface Turn {
  number: string;
  hash: string;
  startedAt: string;
  text: string;
  entryStart: number;
  error?: string;
  aborted?: boolean;
}

export async function work(dir: string, token: string): Promise<void> {
  const runPath = path.join(dir, "run.json");
  const run: Run = readJson(runPath);
  if (run.token !== token || run.state !== "starting" || run.workerPid) throw new Error("Run has already been claimed or generation changed; replay is disabled");
  writeFileSync(path.join(dir, "worker.lock"), JSON.stringify({ token, pid: process.pid, identity: processIdentity(process.pid) }), { flag: "wx", mode: 0o600 });
  let current: Turn | undefined;
  let stopping = false;
  let fatal: string | undefined;
  let rpc: Rpc | undefined;
  const seen = new Map<string, { hash: string; since: number }>();
  const persist = () => { run.heartbeatAt = now(); writeJson(runPath, run); };
  const transition = (state: Run["state"]) => {
    if (state === "idle" && run.state !== "idle") run.idleSince = now();
    if (state === "running") delete run.idleSince;
    run.state = state; run.updatedAt = now(); persist();
  };
  const log = (text: string) => appendFileSync(path.join(dir, "logs", "stderr.log"), text, { mode: 0o600 });
  const archive = (pending?: { number: string; entryStart: number; entryEnd: number }) => {
    if (!existsSync(path.join(dir, "session.jsonl"))) return;
    try {
      const lines = archiveSession(path.join(dir, "session.jsonl"), path.join(dir, "session"));
      refreshReplyDetails(dir, lines, pending);
      delete run.archiveError;
    }
    catch (error: any) {
      run.archiveError = error.message; log(`Archive: ${error.message}\n`);
      try { refreshReplyDetails(dir, undefined, pending); }
      catch (refreshError: any) { log(`Reply details: ${refreshError.message}\n`); }
    }
  };
  const finish = (state: string, error?: string) => {
    if (!current) return;
    const turn = current;
    if (state === "completed") atomicWrite(path.join(dir, `${turn.number}.out.md`), replyDocument(turn.number, turn.text));
    const status = {
      entryStart: turn.entryStart,
      entryEnd: existsSync(path.join(dir, "session.jsonl")) ? parseSessionFile(path.join(dir, "session.jsonl")).entries.length : turn.entryStart,
      number: turn.number, inputHash: turn.hash, state, startedAt: turn.startedAt, endedAt: now(), ...(error ? { error } : {}),
    };
    archive(status);
    writeJson(path.join(dir, `${turn.number}.status.json`), status);
    current = undefined;
    run.lastTurn = turn.number;
    delete run.currentTurn;
    if (!stopping) transition("idle");
  };
  const event = (record: RecordValue) => {
    appendFileSync(path.join(dir, "logs", "events.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
      const error = `Extension requested interactive ${record.method}; PSM runs have no interactive UI`;
      log(`${error}\n`);
      fatal = error;
      void rpc?.send({ type: "extension_ui_response", id: record.id, cancelled: true }).catch((e) => { fatal = e.message; });
    }
    if (record.type === "extension_error") {
      fatal = `Extension failed (${record.extensionPath || "unknown"}, ${record.event || "unknown"}): ${record.error || "unknown error"}`;
      log(`${fatal}\n`);
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
      const error = current.error || fatal;
      finish(record.aborted || current.aborted ? "aborted" : error ? "failed" : "completed", error);
    }
  };
  const stop = (reason: Run["stopReason"] = "signal") => {
    if (stopping) return;
    run.stopReason = reason;
    stopping = true;
    // Unblock startup/acceptance waits too, not only the idle polling loop.
    rpc?.fail(new Error("Shutdown requested"));
  };
  const signalStop = () => stop("signal");
  process.on("SIGTERM", signalStop);
  process.on("SIGINT", signalStop);
  run.workerPid = process.pid;
  run.workerIdentity = processIdentity(process.pid);
  persist();
  // Heartbeats continue while waiting for the startup RPC response.
  const heartbeat = setInterval(() => {
    try {
      persist();
      if (existsSync(path.join(dir, "stop.json")) && readJson(path.join(dir, "stop.json")).token === run.token) stop("requested");
    } catch (e: any) { fatal = e.message; rpc?.fail(e); }
  }, 1000);
  try {
    checkPipeline(run.pipeline);
    const agent = path.join(dir, "agent");
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: dir, PI_GARDEN: "0" };
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    const command = [...run.config.piCommand, "--mode", "rpc", "--session", path.join(dir, "session.jsonl"),
      "--session-dir", dir, ...pipelineArgs(run.pipeline)];
    const pinned = run.model;
    if (pinned) {
      command.push("--provider", pinned.provider, "--model", pinned.model);
      if (pinned.thinking) command.push("--thinking", pinned.thinking);
    } else {
      if (!run.requestedModel) throw new Error("Missing requested model expression");
      command.push("--model", run.requestedModel);
    }
    rpc = new Rpc(command, { cwd: run.cwd, env, log, event });
    rpc.onFailure = (error) => { if (!stopping) fatal = error.message; };
    run.piPid = rpc.child.pid;
    run.piIdentity = run.piPid ? processIdentity(run.piPid) : undefined;
    persist();
    const state = await rpc.request("get_state", {}, run.config.startupTimeoutMs);
    if (typeof state?.model?.id !== "string" || !state.model.id || typeof state.model.provider !== "string" || !state.model.provider)
      throw new Error("Pi did not resolve a model");
    if (pinned && (state.model.id !== pinned.model || state.model.provider !== pinned.provider ||
      (pinned.thinking !== undefined && state.thinkingLevel !== pinned.thinking)))
      throw new Error("Pi selected a different model or thinking level; restart requires the previously resolved selection");
    run.model = { provider: state.model.provider, model: state.model.id,
      ...(typeof state.thinkingLevel === "string" ? { thinking: state.thinkingLevel } : {}) };
    if (fatal) throw new Error(fatal);
    transition("idle");
    while (!stopping && !fatal) {
      if (existsSync(path.join(dir, "stop.json"))) {
        if (readJson(path.join(dir, "stop.json")).token === run.token) { stop("requested"); break; }
      }
      if (current && Date.now() - Date.parse(current.startedAt) > run.config.turnTimeoutMs) {
        fatal = "Turn deadline exceeded; outcome unknown, not replayed";
        break;
      }
      if (!current) {
        const names = readdirSync(dir).filter((name) => /^\d+\.in\.md$/.test(name)).sort();
        for (const name of names) {
          if (!/^(?!000)\d{3}\.in\.md$/.test(name)) throw new Error(`Invalid input number: ${name}; use 001.in.md through 999.in.md`);
        }
        const next = String(Number(run.lastTurn || 0) + 1).padStart(3, "0");
        const name = `${next}.in.md`;
        if (names.includes(name)) {
          const file = path.join(dir, name);
          if (!lstatSync(file).isFile()) throw new Error(`Input must be a regular file: ${name}`);
          if (existsSync(path.join(dir, `${next}.status.json`))) throw new Error(`Input ${next} already has execution state; refusing replay`);
          const text = readFileSync(file, "utf8");
          const hash = createHash("sha256").update(text).digest("hex");
          const previous = seen.get(name);
          if (!previous || previous.hash !== hash) seen.set(name, { hash, since: Date.now() });
          else if (text.trim() && Date.now() - previous.since >= run.config.stableMs) {
            current = { number: next, hash, startedAt: now(), text: "", entryStart: existsSync(path.join(dir, "session.jsonl")) ? parseSessionFile(path.join(dir, "session.jsonl")).entries.length : 0 };
            writeJson(path.join(dir, `${next}.status.json`), { number: next, inputHash: hash, state: "running", startedAt: current.startedAt, entryStart: current.entryStart });
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
        const idleTimeout = run.config.idleTimeoutMs ?? 86400000;
        if (!current && idleTimeout > 0 && run.idleSince && Date.now() - Date.parse(run.idleSince) >= idleTimeout) {
          const release = tryRunLock(dir);
          if (release) {
            try {
              // Re-read under the publisher's lock: accepted input always wins over idle expiry.
              const pending = readdirSync(dir).some((n) => /^\d+\.in\.md$/.test(n) && Number(n.split(".")[0]) > Number(run.lastTurn || 0));
              if (!pending) { stop("idle_timeout"); transition("stopping"); }
            } finally { release(); }
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
    try { await rpc?.close(); }
    catch (error: any) { fatal = fatal || error.message; }
    archive();
    if (fatal) { run.error = fatal; run.stopReason = "error"; log(`${fatal}\n`); }
    transition(fatal ? "failed" : "stopped");
    clearInterval(heartbeat);
    process.off("SIGTERM", signalStop);
    process.off("SIGINT", signalStop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  work(path.resolve(process.argv[2]), process.argv[3]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
