import path from "node:path";
import { parseSessionFile } from "./parser.ts";
import { renderFull } from "./render/full.ts";
import { renderL3 } from "./render/l3.ts";
import { atomicWrite } from "./psm/files.ts";

/** Explicit-layout archive entry point. No sessions/garden path inference or sibling renumbering. */
export function archiveSession(source: string, outputBase: string): Map<number, { start: number; end: number }> {
  const { header, entries } = parseSessionFile(source);
  if (!header) throw new Error(`Session header missing: ${source}`);
  const options = { sourceName: path.basename(source) };
  const lines = new Map<number, { start: number; end: number }>();
  atomicWrite(`${outputBase}.l1.md`, renderFull(header, entries, { ...options, level: "l1",
    onEntry: (_entry, index, start, end) => { lines.set(index, { start, end }); },
  }));
  atomicWrite(`${outputBase}.l3.md`, renderL3(header, entries, options));
  return lines;
}
