import type { Entry, SessionHeader } from "../types.ts";
import { branchNote, fmtTime, frontmatter, type RenderOptions } from "./shared.ts";

/**
 * L2：骨架视图，只留最关键的信息。
 *  - user prompt 全量（带 turn 编号）
 *  - 每一轮（user → 下一个 user 之间）只保留最后一条含 text 的 assistant 消息
 *    （标题行附轮级统计：⏱ 耗时 + output tokens）
 *  - 工具调用保留一行摘要（🔧），报错的结果追加 ❌
 *  - compaction / branch_summary 的 summary 保留
 *  - thinking / toolResult 内容 / 图片 丢弃
 */
export function renderL2(header: SessionHeader | null, entries: Entry[], opts: RenderOptions = {}): string {
  const out: string[] = [frontmatter(header, entries, "l2", opts.sourceName)];

  // 当前轮的 tool 摘要行缓冲区：凑成一组 markdown list 再落盘
  let toolBuf: string[] = [];
  // toolCallId → toolBuf 下标，用于报错时回补 ❌
  let toolIdx = new Map<string, number>();
  // 当前轮最后一条含 text 的 assistant 消息（缓冲，遇到下一条 user 时才落盘）
  let pendingText: { text: string; time: string; model?: string } | null = null;

  // turn 统计（user → 下一个 user）：编号、耗时（轮内最后 entry − user entry）、output tokens
  let turnNo = 0;
  let turnStart = NaN; // ms epoch
  let turnEnd = NaN;
  let turnOut = 0;
  let turnHasUsage = false;
  let turnActive = false; // 轮内是否有 assistant/tool 活动（无活动不显统计）
  let turnStatsShown = false; // 一轮只显一次（compaction 等中途 flush 不重复）

  // 轮内「干活」entry（assistant/toolResult/bashExecution）推进 turnEnd：
  // 耗时 = 最后一个干活 entry − user 起点的墙钟时间，不含轮间用户离开/思考时间
  const touchTurn = (iso: string) => {
    if (Number.isNaN(turnStart)) return;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) turnEnd = Number.isNaN(turnEnd) ? t : Math.max(turnEnd, t);
  };

  const takeTurnStats = (): string => {
    if (!turnActive || turnStatsShown) return "";
    const parts: string[] = [];
    const ms = turnEnd - turnStart;
    if (Number.isFinite(ms) && ms >= 0) parts.push(`⏱ ${fmtDur(ms)}`);
    if (turnHasUsage) parts.push(`out ${fmtTok(turnOut)}`);
    if (!parts.length) return "";
    turnStatsShown = true;
    return parts.join(" · ");
  };

  const flushTools = () => {
    if (toolBuf.length) out.push(toolBuf.join("\n"));
    toolBuf = [];
    toolIdx = new Map();
  };
  const flushText = () => {
    const stats = takeTurnStats();
    if (pendingText) {
      out.push(
        `## 🤖 Assistant · ${pendingText.time}${pendingText.model ? ` · ${pendingText.model}` : ""}${stats ? ` · ${stats}` : ""}\n\n${pendingText.text}`,
      );
      pendingText = null;
    } else if (stats) {
      // 一轮没有含 text 的 assistant（全工具调用后结束）：统计退化为独立 meta 行
      out.push(`> ${stats}`);
    }
  };
  const flushAll = () => {
    flushTools();
    flushText();
  };

  let prev: Entry | null = null;
  for (const entry of entries) {
    const note = branchNote(prev, entry);
    if (note) {
      flushAll();
      out.push(note);
    }
    prev = entry;

    if (entry.type === "compaction") {
      flushAll();
      out.push(`## 🗜️ Compaction · ${fmtTime(entry.timestamp)}\n\n${(entry as any).summary ?? ""}`);
      continue;
    }
    if (entry.type === "branch_summary") {
      flushAll();
      out.push(`## ⑂ Branch Summary · ${fmtTime(entry.timestamp)}\n\n${(entry as any).summary ?? ""}`);
      continue;
    }
    if (entry.type !== "message") continue; // 其余元信息进 frontmatter / 忽略

    const msg = (entry as any).message;
    const time = fmtTime(entry.timestamp);
    switch (msg?.role) {
      case "user": {
        flushAll();
        turnNo++;
        turnStart = Date.parse(entry.timestamp);
        turnEnd = turnStart;
        turnOut = 0;
        turnHasUsage = false;
        turnActive = false;
        turnStatsShown = false;
        out.push(`## 👤 User · #${turnNo} · ${time}\n\n${userText(msg.content)}`);
        break;
      }
      case "assistant": {
        turnActive = true;
        touchTurn(entry.timestamp);
        const u = msg.usage;
        if (u) {
          turnOut += u.output ?? 0;
          turnHasUsage = true;
        }
        const texts: string[] = [];
        for (const part of msg.content ?? []) {
          if (part.type === "toolCall") {
            toolIdx.set(part.id, toolBuf.length);
            toolBuf.push(summarizeToolCall(part.name, part.arguments));
          } else if (part.type === "text" && part.text?.trim()) {
            texts.push(part.text);
          }
        }
        if (texts.length) pendingText = { text: texts.join("\n\n"), time, model: msg.model };
        break;
      }
      case "toolResult": {
        turnActive = true;
        touchTurn(entry.timestamp);
        if (msg.isError) {
          const idx = toolIdx.get(msg.toolCallId);
          if (idx != null) toolBuf[idx] += " ❌";
          else {
            flushAll();
            out.push(`- ❌ **${msg.toolName}** 报错`);
          }
        }
        break;
      }
      case "bashExecution": {
        turnActive = true;
        touchTurn(entry.timestamp);
        let line = summarizeToolCall("bash", { command: msg.command });
        if (msg.exitCode) line += " ❌";
        toolBuf.push(line);
        break;
      }
      default:
        break;
    }
  }
  flushAll();
  return out.join("\n\n") + "\n";
}

/** 耗时紧凑格式：45s / 2.6m / 1.2h */
function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/** token 紧凑格式：800 / 5.3k / 1.2M */
function fmtTok(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text as string)
    .join("\n\n");
}

/** 工具调用 → 一行摘要 */
function summarizeToolCall(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let detail: string;
  switch (name) {
    case "bash":
      detail = str(a.command).split("\n")[0];
      break;
    case "read":
    case "write":
    case "edit":
      detail = str(a.path);
      break;
    default:
      detail = JSON.stringify(a);
  }
  detail = detail.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (detail.length > 80) detail = detail.slice(0, 77) + "...";
  return `- 🔧 **${name}** \`${detail}\``;
}
