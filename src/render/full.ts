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
  SESSION_NAME_BUDGET,
  THINKING_BUDGET,
  TOOL_ARG_BUDGET,
  TOOL_RESULT_BUDGET,
  truncateEachLine,
  truncateInline,
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
    case "session_info": {
      // l1 封顶：扩展（如 pi-ssh-remote）会把首条 prompt 全文拼进会话名
      const name = String((entry as any).name ?? "");
      const shown = truncate ? truncateInline(name, SESSION_NAME_BUDGET) : name;
      return `> 🆔 会话命名：**${shown}** · ${time}`;
    }
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
      return `## 🔀 Branch Summary · ${time}\n\n${e.summary ?? ""}\n\n> from: \`${e.fromId}\``;
    }
    case "custom": {
      const e = entry as any;
      const data = truncate ? truncateLongStrings(e.data, CUSTOM_DATA_BUDGET) : e.data;
      let json = JSON.stringify(data ?? null, null, 2);
      if (truncate) json = truncateEachLine(json);
      return `## 📦 Custom (${e.customType}) · ${time}\n\n${fence(json, "json")}`;
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
      return `## 🙋 User · ${time}\n\n${renderUserContent(msg.content)}`;
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
      return `## 🔀 Branch Summary · ${time}\n\n${msg.summary ?? ""}`;
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
  const header = `## ✨ Assistant · ${time}${msg.model ? ` · ${msg.model}` : ""}`;
  const parts: string[] = [header];
  for (const block of msg.content ?? []) {
    if (block.type === "thinking") {
      const thinking = truncate ? truncateLines(block.thinking, THINKING_BUDGET) : block.thinking;
      parts.push(`**🧠 Thinking:**`, "", fence(thinking, "text"));
    } else if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      const args = truncate ? truncateLongStrings(block.arguments, TOOL_ARG_BUDGET) : block.arguments;
      let json = JSON.stringify(args ?? {}, null, 2);
      if (truncate) json = truncateEachLine(json); // stringify 转义换行会合并出超长物理行
      parts.push(`**🔧 \`${block.name}\`** (\`${block.id}\`)`, "", fence(json, "json"));
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
    if (!drop) parts.push(...renderDetails(msg.details, truncate));
  }
  return parts.join("\n\n");
}

/** 字符串值超过该长度且无换行时也不再并入头行，而是渲染为块（头行保持可读） */
const DETAILS_SCALAR_MAX = 120;

/**
 * toolResult details 渲染（2026-09-14 决策）：
 * - 多行字符串值（典型：edit 的 diff/patch）渲染为围栏块——真实换行，
 *   不再是转义 JSON 单行；patch 用 ```diff 高亮，其余用 ```text
 * - L1 去重：patch 存在时跳过 diff（同一修改的两种表示；diff 的绝对行号仍可翻 l0）
 * - 嵌套对象/数组渲染为 JSON 围栏块；标量并入 `**details:**` 头行
 * - 截断与此前正交：字符串值仍先按 DETAILS_BUDGET 做 line 级截断，再渲染成块
 */
function renderDetails(details: unknown, truncate: boolean): string[] {
  const renderJsonBlock = (v: unknown): string => {
    const d = truncate ? truncateLongStrings(v, DETAILS_BUDGET) : v;
    let json = JSON.stringify(d, null, 2);
    if (truncate) json = truncateEachLine(json); // stringify 转义换行会合并出超长物理行
    return fence(json, "json");
  };

  // 非对象 details（字符串/数组等）：原 JSON 路径
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return [`**details:**`, renderJsonBlock(details)];
  }

  const obj = details as Record<string, unknown>;
  const scalars: string[] = [];
  const blocks: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (truncate && k === "diff" && typeof obj.patch === "string" && obj.patch) continue; // L1 patch 优先
    if (typeof v === "string" && (v.includes("\n") || v.length > DETAILS_SCALAR_MAX)) {
      let text = truncate ? truncateLines(v, DETAILS_BUDGET) : v;
      text = text.replace(/\n+$/, ""); // 去掉尾部换行，避免围栏内多出空行
      blocks.push(`**${k}:**`, fence(text, k === "patch" ? "diff" : "text"));
    } else if (v !== null && typeof v === "object") {
      blocks.push(`**${k}:**`, renderJsonBlock(v));
    } else {
      scalars.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  const head = scalars.length ? `**details:** (${scalars.join(" · ")})` : `**details:**`;
  return [head, ...blocks];
}
