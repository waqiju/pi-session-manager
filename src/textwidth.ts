/** Shared CLI/UI terminal-column utilities. No runtime dependency on pi.
 * Upstream implementation and licenses: ./vendor/pi-text/readme.md
 */
import { stripTerminalSequences, truncateToWidth as truncate } from "./vendor/pi-text/utils.js";
export { visibleWidth, stripTerminalSequences as stripAnsi, getGraphemeSegmenter } from "./vendor/pi-text/utils.js";

/** Preserve PSM's single-character ellipsis default. */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
  const result = truncate(text, maxWidth, ellipsis);
  // Upstream appends SGR resets even for plain text; keep Markdown/clipboard clean.
  return text.includes("\x1b") || ellipsis.includes("\x1b") ? result : stripTerminalSequences(result);
}
