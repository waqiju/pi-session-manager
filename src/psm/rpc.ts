import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { delay } from "./files.ts";

export type RecordValue = Record<string, any>;
export class RpcRejection extends Error {}

/** Small CLI-only RPC transport: no runtime dependency on Pi's SDK. */
export class Rpc {
  child: ChildProcessWithoutNullStreams;
  listeners = new Set<(record: RecordValue) => void>();
  pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  failure: Error | undefined;
  closed = false;
  sequence = 0;
  onFailure: (error: Error) => void = () => {};

  constructor(command: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: (text: string) => void; event: (record: RecordValue) => void }) {
    this.child = spawn(command[0], command.slice(1), { cwd: options.cwd, env: options.env, detached: true, stdio: "pipe" });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          if (!record || typeof record.type !== "string") throw new Error("Missing record type");
          options.event(record);
          if (record.type === "response" && this.pending.has(record.id)) {
            const waiter = this.pending.get(record.id)!;
            this.pending.delete(record.id);
            clearTimeout(waiter.timer);
            if (record.success) waiter.resolve(record.data);
            else waiter.reject(new RpcRejection(record.error || `RPC ${record.command} failed`));
          }
          for (const listener of this.listeners) listener(record);
        } catch (error: any) { this.fail(new Error(`RPC record error: ${error.message}`)); }
      }
    });
    this.child.stderr.on("data", (data) => options.log(data.toString()));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.fail(new Error(`Pi exited (code=${code}, signal=${signal})`));
    });
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.onFailure(error);
  }

  async send(record: RecordValue): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.child.stdin.write(JSON.stringify(record) + "\n")) await once(this.child.stdin, "drain");
  }

  request(type: string, fields: RecordValue = {}, timeout = 30000): Promise<any> {
    const id = `psm-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${type} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...fields, type, id }).catch((error) => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    for (let i = 0; i < 20 && !this.closed; i++) await delay(100);
    if (!this.closed) this.signal("SIGTERM");
    for (let i = 0; i < 20 && !this.closed; i++) await delay(100);
    if (!this.closed) this.signal("SIGKILL");
    for (let i = 0; i < 20 && !this.closed; i++) await delay(100);
    if (!this.closed) throw new Error("Pi exit not confirmed after shutdown");
  }

  signal(signal: NodeJS.Signals): void {
    if (this.child.pid) {
      try { process.kill(-this.child.pid, signal); } catch { /* already gone */ }
    }
  }
}
