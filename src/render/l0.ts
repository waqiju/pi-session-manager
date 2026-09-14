import type { Entry, SessionHeader } from "../types.ts";
import { renderFull } from "./full.ts";
import type { RenderOptions } from "./shared.ts";

/** L0：尽量 1:1，全量渲染 */
export function renderL0(header: SessionHeader | null, entries: Entry[], opts: RenderOptions = {}): string {
  return renderFull(header, entries, { ...opts, level: "l0" });
}
