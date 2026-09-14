/**
 * pi session 文件格式（.jsonl）的类型定义。
 * 依据: pi-coding-agent docs/session-format.md （version 3）
 *
 * 注意：本仓库用 node 原生 type-stripping 运行，只允许可擦除语法
 * （不写 enum / namespace / parameter properties）。
 */

// ---------- Content blocks ----------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

// ---------- Messages ----------

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  reasoning?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[] | string;
  details?: unknown;
  usage?: Usage;
  isError?: boolean;
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp?: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp?: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

// ---------- Entries ----------

export interface EntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string; // ISO
}

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore: number;
  retainedTail?: AgentMessage[];
  details?: { readFiles?: string[]; modifiedFiles?: string[] } & Record<string, unknown>;
  usage?: Usage;
  fromHook?: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  usage?: Usage;
  details?: { readFiles?: string[]; modifiedFiles?: string[] } & Record<string, unknown>;
  fromHook?: boolean;
}

export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
}

export interface LabelEntry extends EntryBase {
  type: "label";
  targetId: string;
  label?: string;
}

export interface SessionInfoEntry extends EntryBase {
  type: "session_info";
  name: string;
}

export type Entry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;
