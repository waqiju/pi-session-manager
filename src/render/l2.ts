import type { Entry, SessionHeader } from "../types.ts";
import type { RenderOptions } from "./shared.ts";
import { renderSkeleton } from "./skeleton.ts";

/** L2：骨架视图（user prompt 全量 + assistant text 全量按序交织 + 工具一行摘要） */
export function renderL2(header: SessionHeader | null, entries: Entry[], opts: RenderOptions = {}): string {
  return renderSkeleton(header, entries, { ...opts, level: "l2" });
}
