import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function readJson(file: string, fallback?: any): any {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error: any) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new Error(`Cannot read JSON: ${file}: ${error.message}`, { cause: error });
  }
}

export function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
}

export function writeJson(file: string, value: unknown): void {
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const now = () => new Date().toISOString();
