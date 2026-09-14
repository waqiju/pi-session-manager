import type { Entry, SessionHeader } from "../types.ts";
import { branchNote, fmtTime, frontmatter, type RenderOptions } from "./shared.ts";

/**
 * L2：骨架视图，只留最关键的信息。
 *  - user prompt 全量
 *  - 每一轮（user → 下一个 user 之间）只保留最后一条含 text 的 assistant 消息
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

  const flushTools = () => {
    if (toolBuf.length) out.push(toolBuf.join("\n"));
    toolBuf = [];
    toolIdx = new Map();
  };
  const flushText = () => {
    if (pendingText) {
      out.push(`## 🤖 Assistant · ${pendingText.time}${pendingText.model ? ` · ${pendingText.model}` : ""}\n\n${pendingText.text}`);
      pendingText = null;
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
        out.push(`## 👤 User · ${time}\n\n${userText(msg.content)}`);
        break;
      }
      case "assistant": {
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
