import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { delay, writeJson } from "./files.ts";

/** Start identity distinguishes PID reuse and reboot. Unknown probes fail closed. */
export function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
      return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    }).trim() || undefined;
  } catch { return undefined; }
}

export function processPresent(pid?: number, identity?: string): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); }
  catch (error: any) { return error.code !== "ESRCH"; }
  if (process.platform === "linux") {
    try {
      const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)![0];
      if (state === "Z" || state === "X") return false;
    } catch { /* Cannot prove exit. */ }
  }
  const actual = identity && processIdentity(pid);
  return !(identity && actual && identity !== actual);
}

/** Never reclaim an uncertain lock automatically: a paused owner may still publish. */
export function tryRunLock(dir: string): (() => void) | undefined {
  const lock = path.join(dir, "control.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error: any) { if (error.code === "EEXIST") return; throw error; }
  try { writeJson(path.join(lock, "owner.json"), { pid: process.pid, identity: processIdentity(process.pid) }); }
  catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
  return () => rmSync(lock, { recursive: true, force: true });
}

export async function withRunLock<T>(dir: string, action: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const release = tryRunLock(dir);
    if (release) { try { return await action(); } finally { release(); } }
    if (Date.now() >= deadline) throw new Error(`Run control is locked: ${path.join(dir, "control.lock")}; inspect owner.json and remove the lock only after confirming its owner has exited`);
    await delay(25);
  }
}
