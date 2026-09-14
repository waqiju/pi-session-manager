import type { Entry, SessionHeader } from "../types.ts";
import { renderFull } from "./full.ts";
import type { RenderOptions } from "./shared.ts";

/** L1：与 L0 相同，但 toolResult 内容与 toolCall args 中超长字符串做头尾截断 */
export function renderL1(header: SessionHeader | null, entries: Entry[], opts: RenderOptions = {}): string {
  return renderFull(header, entries, { ...opts, level: "l1" });
}
