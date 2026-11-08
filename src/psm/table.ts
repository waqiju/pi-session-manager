import { stripAnsi, truncateToWidth, visibleWidth } from "../textwidth.ts";
import type { Run } from "./runs.ts";

/** Display in the CLI process's local timezone, without milliseconds. */
export function localTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Plain terminal table; never allow metadata to inject terminal controls. */
export function formatRuns(runs: (Run & { alive: boolean })[], columns = 120): string {
  const clean = (text: string) => stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  const rows = [["ID", "STATE", "ALIVE", "GROUP", "MODEL", "TURN", "UPDATED"],
    ...runs.map((run) => [run.id, run.state, run.alive ? "yes" : "no", run.group,
      `${run.model.provider}/${run.model.model}`, run.currentTurn || run.lastTurn || "-", localTime(run.updatedAt)])]
    .map((row) => row.map(clean));
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => visibleWidth(row[i]))));
  const budget = Math.max(29, columns - (widths.length * 3 + 1));
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const index = widths.indexOf(Math.max(...widths));
    if (widths[index] <= 3) break;
    widths[index]--;
  }
  const border = (left: string, middle: string, right: string) => left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right;
  const row = (cells: string[]) => "│" + cells.map((cell, i) => {
    const text = truncateToWidth(cell, widths[i]);
    return ` ${text}${" ".repeat(Math.max(0, widths[i] - visibleWidth(text)))} `;
  }).join("│") + "│";
  return [border("┌", "┬", "┐"), row(rows[0]), border("├", "┼", "┤"),
    ...rows.slice(1).map(row), border("└", "┴", "┘"),
    `${runs.length} run(s) · psm status <id> for full details`].join("\n");
}
