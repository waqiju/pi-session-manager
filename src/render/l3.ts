import type { Entry, SessionHeader } from "../types.ts";
import type { RenderOptions } from "./shared.ts";
import { renderSkeleton } from "./skeleton.ts";

/** L3：纯问答视图（L2 基础上每轮只保留最后一段 assistant text；thinking/中间 text/工具行丢弃） */
export function renderL3(header: SessionHeader | null, entries: Entry[], opts: RenderOptions = {}): string {
  return renderSkeleton(header, entries, { ...opts, level: "l3" });
}
