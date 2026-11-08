import path from "node:path";
import { parseSessionFile } from "./parser.ts";
import { renderL1 } from "./render/l1.ts";
import { renderL3 } from "./render/l3.ts";
import { atomicWrite } from "./psm/files.ts";

/** Explicit-layout archive entry point. No sessions/garden path inference or sibling renumbering. */
export function archiveSession(source: string, outputBase: string): void {
  const { header, entries } = parseSessionFile(source);
  if (!header) throw new Error(`Session header missing: ${source}`);
  const options = { sourceName: path.basename(source) };
  atomicWrite(`${outputBase}.l1.md`, renderL1(header, entries, options));
  atomicWrite(`${outputBase}.l3.md`, renderL3(header, entries, options));
}
