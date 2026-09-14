import type { Entry, SessionHeader } from "../types.ts";
import { branchNote, fmtTime, frontmatter, type RenderOptions } from "./shared.ts";

export interface SkeletonRenderOptions extends RenderOptions {
  /** l3 = finalOnly：l2 基础上每轮只保留最后一段 assistant text */
  level: "l2" | "l3";
}

/**
 * L2/L3 共用引擎：骨架视图，只留最关键的信息。
 *  - user prompt 全量（带 turn 编号）
 *  - 每轮一个 assistant 节（标题 = 轮内首条 assistant 的时间/模型 + 轮级统计：
 *    ⏱ 耗时 + output tokens）；两级标题完全一致，便于跨级别对照
 *  - L2：assistant text 全量保留（2026-09-14 决策：中间 text 虽短但承上启下），
 *    按时间序与工具行交织；thinking 只留占位段落 `**🧠 Thinking**`（内容丢弃）；
 *    工具调用保留一行摘要（🔧），连续的并为一组 list，报错的结果追加 ❌
 *  - L3（finalOnly）：每轮只保留最后一段 assistant text——最后一条 assistant
 *    消息无 text 时向前找轮内最近的 text；thinking 占位 / 中间 text / 工具行
 *    （含 ❌ 报错标记）全部丢弃；轮内无 assistant text 时 assistant 节整体省略，
 *    有统计则退化为独立 meta 行
 *  - compaction / branch_summary 的 summary 保留
 *  - toolResult 内容 / 图片 丢弃
 */
export function renderSkeleton(
  header: SessionHeader | null,
  entries: Entry[],
  opts: SkeletonRenderOptions,
): string {
  const finalOnly = opts.level === "l3";
  const out: string[] = [frontmatter(header, entries, opts.level, opts.sourceName)];

  // 当前轮的内容项（按到达顺序）：tool = 工具摘要行（落盘时连续的并为一组 list）；
  // block = 独立段落（text / thinking 占位）。finalOnly 模式下不使用（只记 turnFinalText）
  let turnItems: { kind: "tool" | "block"; text: string }[] = [];
  // toolCallId → turnItems 下标，用于报错时回补 ❌
  let toolIdx = new Map<string, number>();
  // finalOnly：轮内最后一段 assistant text（每遇到一段就覆盖）
  let turnFinalText: string | null = null;
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

  // 轮落盘：L2 连续 tool 行并为一组 list，block 段落原样；L3 只留最终 text。
  // 有 assistant 则加节标题
  const flushTurn = () => {
    const parts: string[] = [];
    if (finalOnly) {
      if (turnFinalText != null) parts.push(turnFinalText);
    } else {
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
    }
    turnItems = [];
    toolIdx = new Map();
    turnFinalText = null;

    const stats = takeTurnStats();
    if (!parts.length) {
      // 轮内无可见内容（L2: assistant 空 content；L3: 无 text 轮——纯工具/abort/
      // 仅 bashExecution）：assistant 节整体省略，统计退化为独立 meta 行
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
          if (part.type === "text" && part.text?.trim()) {
            // L3 只记轮内最后一段 text；L2 全部保留（按序交织）
            if (finalOnly) turnFinalText = part.text;
            else turnItems.push({ kind: "block", text: part.text });
          } else if (!finalOnly && part.type === "thinking" && part.thinking?.trim()) {
            turnItems.push({ kind: "block", text: "**🧠 Thinking**" });
          } else if (!finalOnly && part.type === "toolCall") {
            toolIdx.set(part.id, turnItems.length);
            turnItems.push({ kind: "tool", text: summarizeToolCall(part.name, part.arguments) });
          }
        }
        break;
      }
      case "toolResult": {
        turnActive = true;
        touchTurn(entry.timestamp);
        // ❌ 依附工具行存在；L3 无工具行，报错标记随之丢弃（报错细节去 l1/l2 查）
        if (!finalOnly && msg.isError) {
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
        if (!finalOnly) {
          let line = summarizeToolCall("bash", { command: msg.command });
          if (msg.exitCode) line += " ❌";
          turnItems.push({ kind: "tool", text: line });
        }
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
