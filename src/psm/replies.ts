import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { atomicWrite, readJson } from "./files.ts";

export function replyDocument(number: string, text: string, range?: { start: number; end: number }): string {
  return `---\nround: "${number}"\ndetail_file: session.l1.md\n${range
    ? `detail_start_line: ${range.start}\ndetail_end_line: ${range.end}`
    : "detail_status: unavailable"}\n---\n\n${text}`;
}

/** Refresh only our metadata, preserving the answer body exactly. */
export function refreshReplyDetails(dir: string, lines?: Map<number, { start: number; end: number }>, pending?: { number: string; entryStart: number; entryEnd: number }): void {
  for (const name of readdirSync(dir).filter((n) => /^\d{3}\.out\.md$/.test(n))) {
    const number = name.slice(0, 3);
    const status = pending?.number === number ? pending : readJson(path.join(dir, `${number}.status.json`), {});
    const start = lines?.get(status.entryStart)?.start;
    const end = lines?.get(status.entryEnd - 1)?.end;
    const file = path.join(dir, name);
    const body = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n\n/, "");
    atomicWrite(file, replyDocument(number, body, start !== undefined && end !== undefined && end >= start ? { start, end } : undefined));
  }
}
