import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { inspectRun } from "./runs.ts";

/** Byte cursor: complete JSONL records only; memory bounded by the largest record. */
export class EventReader {
  private identity = "";
  private offset = 0;
  private pending = Buffer.alloc(0);
  private anchor = Buffer.alloc(0);
  private skipPartial = false;
  generation = 0;
  private file: string;
  private lines: number;
  constructor(file: string, lines: number) { this.file = file; this.lines = lines; }

  *read(): Generator<string> {
    let fd: number;
    try { fd = openSync(this.file, "r"); }
    catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    try {
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (!this.identity) {
        this.offset = tailOffset(fd, stat.size, this.lines);
        if (!this.lines && stat.size) {
          const last = Buffer.alloc(1);
          readSync(fd, last, 0, 1, stat.size - 1);
          this.skipPartial = last[0] !== 10;
        }
      }
      else {
        const check = Buffer.alloc(this.anchor.length);
        if (this.offset >= check.length) readSync(fd, check, 0, check.length, this.offset - check.length);
        if (identity !== this.identity || stat.size < this.offset || !check.equals(this.anchor)) {
          this.offset = 0;
          this.pending = Buffer.alloc(0);
          this.skipPartial = false;
          this.generation++;
        }
      }
      this.identity = identity;
      while (this.offset < stat.size) {
        const chunk = Buffer.alloc(Math.min(65536, stat.size - this.offset));
        const count = readSync(fd, chunk, 0, chunk.length, this.offset);
        if (!count) break;
        this.offset += count;
        this.pending = Buffer.concat([this.pending, chunk.subarray(0, count)]);
        let start = 0;
        let end: number;
        while ((end = this.pending.indexOf(10, start)) !== -1) {
          if (this.skipPartial) this.skipPartial = false;
          else yield this.pending.subarray(start, end).toString("utf8").replace(/\r$/, "");
          start = end + 1;
        }
        this.pending = Buffer.from(this.pending.subarray(start));
      }
      this.anchor = Buffer.alloc(Math.min(64, this.offset));
      readSync(fd, this.anchor, 0, this.anchor.length, this.offset - this.anchor.length);
    } finally { closeSync(fd); }
  }
}

function tailOffset(fd: number, size: number, lines: number): number {
  if (!lines) return size;
  let position = size;
  let boundaries = 0;
  while (position > 0) {
    const start = Math.max(0, position - 65536);
    const chunk = Buffer.alloc(position - start);
    readSync(fd, chunk, 0, chunk.length, start);
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] === 10 && start + i !== size - 1 && ++boundaries === lines) return start + i + 1;
    }
    position = start;
  }
  return 0;
}

// Logs are data, not terminal commands. Preserve Markdown source but strip controls.
function plain(value: unknown): string {
  return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function summary(value: unknown): string {
  return plain(value).replace(/\s+/g, " ").slice(0, 240);
}

export class TextEvents {
  private blocks = new Map<number, string>();
  private lineOpen = false;
  private label(text: string): string {
    const prefix = this.lineOpen ? "\n" : "";
    this.lineOpen = false;
    return `${prefix}[${plain(text)}]\n`;
  }
  private text(index: number, text: string): string {
    const previous = this.blocks.get(index) || "";
    this.blocks.set(index, text);
    const addition = text.startsWith(previous) ? text.slice(previous.length) : text;
    const output = plain(addition);
    if (output) this.lineOpen = !output.endsWith("\n");
    return output;
  }
  format(event: any): string {
    const message = event.message;
    if (event.type === "message_start" && message?.role === "assistant") {
      this.blocks.clear();
      return this.label("assistant");
    }
    if (event.type === "message_update" || event.type === "message_end") {
      if (message?.role !== "assistant") return "";
      let output = "";
      if (Array.isArray(message.content)) {
        message.content.forEach((block: any, index: number) => {
          if (block.type === "text") output += this.text(index, block.text || "");
        });
      } else {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "text_delta") {
          const index = delta.contentIndex ?? 0;
          output += this.text(index, (this.blocks.get(index) || "") + delta.delta);
        }
      }
      if (event.type === "message_end") {
        if (this.lineOpen) { output += "\n"; this.lineOpen = false; }
        if (message.errorMessage) output += this.label(`error: ${summary(message.errorMessage)}`);
        this.blocks.clear();
      }
      return output;
    }
    if (event.type === "tool_execution_start") return this.label(`tool ${event.toolName} started (${event.toolCallId})`);
    if (event.type === "tool_execution_end") {
      const text = event.result?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
      return this.label(`tool ${event.toolName} ${event.isError ? "failed" : "completed"} (${event.toolCallId})${text ? `: ${summary(text)}` : ""}`);
    }
    if (event.type === "agent_start") return this.label("running");
    if (event.type === "agent_settled") return this.label(event.aborted ? "aborted" : "settled");
    if (event.type === "auto_retry_start") return this.label(`retry ${event.attempt ?? ""}: ${summary(event.errorMessage)}`);
    if (event.type === "auto_retry_end") return this.label(`retry ${event.success ? "succeeded" : "ended"}${event.finalError ? `: ${summary(event.finalError)}` : ""}`);
    if (event.type === "auto_compaction_start") return this.label("compacting context");
    if (event.type === "auto_compaction_end") return this.label("context compaction ended");
    if (event.type === "extension_error") return this.label(`extension error: ${summary(event.error)}`);
    if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method))
      return this.label(`error: extension requested interactive ${event.method}; PSM has no interactive UI`);
    if (event.type === "response" && event.success === false) return this.label(`error: ${summary(event.error)}`);
    return "";
  }
}

export async function followLogs(dir: string, options: {
  format: "text" | "json"; lines: number; follow: boolean; signal?: AbortSignal;
  write: (text: string) => Promise<void>; diagnostic: (text: string) => void;
}): Promise<void> {
  const reader = new EventReader(path.join(dir, "logs", "events.jsonl"), options.lines);
  let formatter = new TextEvents();
  let generation = reader.generation;
  const drain = async () => {
    for (const line of reader.read()) {
      if (reader.generation !== generation) {
        formatter = new TextEvents();
        generation = reader.generation;
      }
      if (options.signal?.aborted) return;
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); }
      catch { options.diagnostic("Skipping malformed event record\n"); continue; }
      const output = options.format === "json" ? line + "\n" : formatter.format(event);
      if (output) await options.write(output);
    }
  };
  while (!options.signal?.aborted) {
    await drain();
    if (!options.follow) return;
    const run = inspectRun(dir);
    if (["stopped", "failed", "interrupted"].includes(run.state)) {
      await drain();
      options.diagnostic(`Run ${run.id}: ${run.state}${run.error ? ` (${summary(run.error)})` : ""}\n`);
      return;
    }
    try { await pause(200, undefined, { signal: options.signal }); }
    catch (error: any) { if (error.name !== "AbortError") throw error; }
  }
}
