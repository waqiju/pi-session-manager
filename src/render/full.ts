import type {
  AgentMessage,
  AssistantMessage,
  ContentBlock,
  Entry,
  SessionHeader,
  ToolResultMessage,
} from "../types.ts";
import {
  CUSTOM_DATA_BUDGET,
  DETAILS_BUDGET,
  THINKING_BUDGET,
  TOOL_ARG_BUDGET,
  TOOL_RESULT_BUDGET,
  truncateLines,
  truncateLongStrings,
} from "./truncate.ts";
import {
  DETAILS_DROP_TOOLS,
  branchNote,
  fence,
  fmtTime,
  frontmatter,
  imagePlaceholder,
  isEmptyDetails,
  type RenderOptions,
} from "./shared.ts";

export interface FullRenderOptions extends RenderOptions {
  level: "l0" | "l1";
}

/**
 * L0 / L1 渲染引擎：按文件顺序忠实渲染所有 entry。
 * L1 与 L0 的唯一区别是截断策略（toolResult 内容、toolCall args 超长字符串）。
 */
export function renderFull(
  header: SessionHeader | null,
  entries: Entry[],
  opts: FullRenderOptions,
): string {
  const truncate = opts.level === "l1";
  const out: string[] = [frontmatter(header, entries, opts.level, opts.sourceName)];
  let prev: Entry | null = null;
  for (const entry of entries) {
    const note = branchNote(prev, entry);
    if (note) out.push(note);
    const block = renderEntry(entry, truncate);
    if (block) out.push(block);
    prev = entry;
  }
  return out.join("\n\n") + "\n";
}

function renderEntry(entry: Entry, truncate: boolean): string | null {
  const time = fmtTime(entry.timestamp);
  switch (entry.type) {
    case "message":
      return renderMessage((entry as any).message, time, truncate);
    case "model_change":
      return `> 🔄 模型切换 → **${(entry as any).provider}/${(entry as any).modelId}** · ${time}`;
    case "thinking_level_change":
      return `> 🧠 thinking level → **${(entry as any).thinkingLevel}** · ${time}`;
    case "session_info":
      return `> 📛 会话命名：**${(entry as any).name}** · ${time}`;
    case "label": {
      const e = entry as any;
      return e.label
        ? `> 🏷️ 标记 \`${e.targetId}\`：**${e.label}** · ${time}`
        : `> 🏷️ 取消标记 \`${e.targetId}\` · ${time}`;
    }
    case "compaction": {
      const e = entry as any;
      const parts: string[] = [`## 🗜️ Compaction · ${time}`, "", e.summary ?? ""];
      const meta: string[] = [`tokensBefore: ${e.tokensBefore}`];
      if (e.details?.readFiles?.length) meta.push(`readFiles: ${e.details.readFiles.join(", ")}`);
      if (e.details?.modifiedFiles?.length) meta.push(`modifiedFiles: ${e.details.modifiedFiles.join(", ")}`);
      parts.push("", `> ${meta.join(" · ")}`);
      return parts.join("\n");
    }
    case "branch_summary": {
      const e = entry as any;
      return `## ⑂ Branch Summary · ${time}\n\n${e.summary ?? ""}\n\n> from: \`${e.fromId}\``;
    }
    case "custom": {
      const e = entry as any;
      const data = truncate ? truncateLongStrings(e.data, CUSTOM_DATA_BUDGET) : e.data;
      return `## 📦 Custom (${e.customType}) · ${time}\n\n${fence(JSON.stringify(data ?? null, null, 2), "json")}`;
    }
    case "custom_message": {
      const e = entry as any;
      return `## 📎 Custom Message (${e.customType}) · ${time}\n\n${renderUserContent(e.content)}`;
    }
    default:
      return `## ❓ 未知 entry (${entry.type}) · ${time}\n\n${fence(JSON.stringify(entry, null, 2), "json")}`;
  }
}

function renderMessage(msg: AgentMessage, time: string, truncate: boolean): string {
  switch (msg.role) {
    case "user":
      return `## 👤 User · ${time}\n\n${renderUserContent(msg.content)}`;
    case "assistant":
      return renderAssistant(msg, time, truncate);
    case "toolResult":
      return renderToolResult(msg, time, truncate);
    case "bashExecution": {
      const output = truncate ? truncateLines(msg.output ?? "", TOOL_RESULT_BUDGET) : (msg.output ?? "");
      const lines = [
        `## 💻 Bash · ${time}`,
        "",
        fence(msg.command ?? "", "bash"),
        "",
        `exit: ${msg.exitCode ?? "?"}${msg.cancelled ? " (cancelled)" : ""}${msg.truncated ? " (truncated)" : ""}`,
        "",
        fence(output),
      ];
      return lines.join("\n");
    }
    case "custom":
      return `## 📎 Custom (${msg.customType}) · ${time}\n\n${renderUserContent(msg.content)}`;
    case "branchSummary":
      return `## ⑂ Branch Summary · ${time}\n\n${msg.summary ?? ""}`;
    case "compactionSummary":
      return `## 🗜️ Compaction Summary · ${time}\n\n${msg.summary ?? ""}`;
    default:
      return `## ❓ 未知消息 (${(msg as any).role}) · ${time}\n\n${fence(JSON.stringify(msg, null, 2), "json")}`;
  }
}

function renderUserContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content ?? []) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push(imagePlaceholder(block.mimeType, block.data));
  }
  return parts.join("\n\n");
}

function renderAssistant(msg: AssistantMessage, time: string, truncate: boolean): string {
  const header = `## 🤖 Assistant · ${time}${msg.model ? ` · ${msg.model}` : ""}`;
  const parts: string[] = [header];
  for (const block of msg.content ?? []) {
    if (block.type === "thinking") {
      const thinking = truncate ? truncateLines(block.thinking, THINKING_BUDGET) : block.thinking;
      parts.push(`**🧠 Thinking:**`, "", fence(thinking, "text"));
    } else if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      const args = truncate ? truncateLongStrings(block.arguments, TOOL_ARG_BUDGET) : block.arguments;
      parts.push(`**🔧 \`${block.name}\`** (\`${block.id}\`)`, "", fence(JSON.stringify(args ?? {}, null, 2), "json"));
    }
  }
  if (msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse") {
    parts.push(`> ⚠️ stopReason: \`${msg.stopReason}\`${msg.errorMessage ? ` — ${msg.errorMessage}` : ""}`);
  }
  return parts.join("\n\n");
}

function renderToolResult(msg: ToolResultMessage, time: string, truncate: boolean): string {
  const header = `## 🔧 Tool Result · ${msg.toolName} · ${time}${msg.isError ? " ❌" : ""}`;
  const parts: string[] = [header];
  const content = msg.content;
  if (typeof content === "string") {
    parts.push(fence(truncate ? truncateLines(content, TOOL_RESULT_BUDGET) : content));
  } else {
    for (const block of content ?? []) {
      if (block.type === "text") {
        parts.push(fence(truncate ? truncateLines(block.text, TOOL_RESULT_BUDGET) : block.text));
      } else if (block.type === "image") {
        parts.push(imagePlaceholder(block.mimeType, block.data));
      }
    }
  }
  if (msg.details != null && !isEmptyDetails(msg.details)) {
    // 方案 B: L1 丢弃输出型工具（bash/read/write/grep/...）的 details（纯冗余，text 已含全部信息）；
    // edit 等含独有信息（diff/patch）的工具保留，按 DETAILS_BUDGET 做 line 级截断。
    const drop = truncate && DETAILS_DROP_TOOLS.has(msg.toolName ?? "");
    if (!drop) {
      const details = truncate ? truncateLongStrings(msg.details, DETAILS_BUDGET) : msg.details;
      parts.push(`**details:**`, "", fence(JSON.stringify(details, null, 2), "json"));
    }
  }
  return parts.join("\n\n");
}
