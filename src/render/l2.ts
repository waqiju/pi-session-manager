import type { Entry, SessionHeader } from "../types.ts";
import { branchNote, fmtTime, frontmatter, type RenderOptions } from "./shared.ts";

/**
 * L2：骨架视图，只留最关键的信息。
 *  - user prompt 全量（带 turn 编号）
 *  - assistant text 全量保留（2026-09-14 决策：中间 text 虽短但承上启下），
 *    按时间序与工具行交织；每轮一个 assistant 节（标题 = 轮内首条 assistant
 *    的时间/模型 + 轮级统计：⏱ 耗时 + output tokens）
 *  - thinking 只留占位段落 `**🧠 Thinking**`（表示模型在此思考过），内容丢弃
 *  - 工具调用保留一行摘要（🔧），连续的并为一组 list，报错的结果追加 ❌
 *  - compaction / branch_summary 的 summary 保留
 *  - toolResult 内容 / 图片 丢弃
 */
export function renderL2(header: SessionHeader | null, entries: Entry[], opts: RenderOptions = {}): string {
  const out: string[] = [frontmatter(header, entries, "l2", opts.sourceName)];

  // 当前轮的内容项（按到达顺序）：tool = 工具摘要行（落盘时连续的并为一组 list）；
  // block = 独立段落（text / thinking 占位）
  let turnItems: { kind: "tool" | "block"; text: string }[] = [];
  // toolCallId → turnItems 下标，用于报错时回补 ❌
  let toolIdx = new Map<string, number>();
  // 轮内首条 assistant 消息的时间/模型（节标题用）
  let sectionMeta: { time: string; model?: string } | null = null;

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

  // 轮落盘：连续 tool 行并为一组 list，block 段落原样；有 assistant 则加节标题
  const flushTurn = () => {
    const parts: string[] = [];
    let toolRun: string[] = [];
    const flushRun = () => {
      if (toolRun.length) parts.push(toolRun.join("\n"));
      toolRun = [];
    };
    for (const item of turnItems) {
      if (item.kind === "tool") toolRun.push(item.text);
      else {
        flushRun();
        parts.push(item.text);
      }
    }
    flushRun();
    turnItems = [];
    toolIdx = new Map();

    const stats = takeTurnStats();
    if (!parts.length) {
      // 轮内无可见内容（如 assistant 空 content）：统计退化为独立 meta 行
      if (stats) out.push(`> ${stats}`);
    } else if (sectionMeta) {
      const head = `## 🤖 Assistant · ${sectionMeta.time}${sectionMeta.model ? ` · ${sectionMeta.model}` : ""}${stats ? ` · ${stats}` : ""}`;
      out.push(`${head}\n\n${parts.join("\n\n")}`);
    } else {
      // 无 assistant（如只有 bashExecution）：裸内容 + 统计 meta 行
      out.push(parts.join("\n\n"));
      if (stats) out.push(`> ${stats}`);
    }
    sectionMeta = null;
  };
  const flushAll = flushTurn;

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
        if (!sectionMeta) sectionMeta = { time, model: msg.model };
        for (const part of msg.content ?? []) {
          if (part.type === "thinking" && part.thinking?.trim()) {
            turnItems.push({ kind: "block", text: "**🧠 Thinking**" });
          } else if (part.type === "toolCall") {
            toolIdx.set(part.id, turnItems.length);
            turnItems.push({ kind: "tool", text: summarizeToolCall(part.name, part.arguments) });
          } else if (part.type === "text" && part.text?.trim()) {
            turnItems.push({ kind: "block", text: part.text });
          }
        }
        break;
      }
      case "toolResult": {
        turnActive = true;
        touchTurn(entry.timestamp);
        if (msg.isError) {
          const idx = toolIdx.get(msg.toolCallId);
          if (idx != null) turnItems[idx].text += " ❌";
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
        turnItems.push({ kind: "tool", text: line });
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
