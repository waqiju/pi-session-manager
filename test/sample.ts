/** 手工构造的 session fixture：覆盖全部 entry 类型 + 分支跳回 + compaction */

/** 每次 buildSample 调用前复位，保证输出确定（可重复构造相同 fixture） */
let seq = 0;
let ts = 0;
const id = () => `id${String(++seq).padStart(6, "0")}`;
const time = () => new Date((ts += 1000)).toISOString();

/** 多行长文本 fixture：line 级截断只按整行切，填充内容必须是多行 */
const pad = (prefix: string, n: number, width: number) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(3, "0")} ${"x".repeat(width)}`);

// 202 行 ≈ 6KB（TOOL_RESULT_BUDGET=1000 → 截后：头 21 行 / 尾 14 行 / 省略 167 行）
const LONG_RESULT = ["HEAD_MARKER", ...pad("result padding line", 200, 5), "TAIL_MARKER"].join("\n");
// 60 行 ≈ 3.1KB（TOOL_ARG_BUDGET=800 → 截后：头 10 行 / 尾 7 行）
const LONG_ARG = pad("arg padding line", 60, 30).join("\n");
// 62 行 ≈ 1.9KB（THINKING_BUDGET=1000 → 截后：头 20 行 / 尾 14 行）
export const THINKING_TEXT = ["THINK_HEAD", ...pad("thinking padding line", 60, 5), "THINK_TAIL"].join("\n");
export const INTERMEDIATE_TEXT = "我先读取一下这个文件";
export const FINAL_TEXT_T1 = "完成了：文件内容是一个测试包配置。";
export const FINAL_TEXT_T2 = "好的，换个思路来做。";
export const FINAL_TEXT_T3 = "最终回答：全部搞定。";
export const USER_PROMPT_1 = "请读取 package.json 并总结";
export const COMPACTION_SUMMARY = "## Goal\n测试压缩摘要：用户在做 garden 工具开发。";
export const EDIT_DIFF = "   27   <path class=\"fold\" d=\"M 396 118 L 248 252\"/>\n- 31   <circle class=\"eye\" cx=\"368\" cy=\"136\" r=\"4.5\"/>\n+ 31   <circle class=\"eye\" cx=\"340\" cy=\"161\" r=\"4\"/>\n 32 </svg>";
/** read 被截断时 details.truncation.content 是 content.text 的重复副本（冗余） */
export const READ_TRUNCATION_CONTENT = "x".repeat(3000);

export function buildSample(): { header: Record<string, unknown>; entries: Record<string, unknown>[] } {
  seq = 0;
  ts = Date.parse("2026-09-14T01:00:00.000Z");
  const header = {
    type: "session",
    version: 3,
    id: "test-session-uuid",
    timestamp: "2026-09-14T01:00:00.000Z",
    cwd: "/tmp/proj",
  };

  const eModelChange = { type: "model_change", id: id(), parentId: null, timestamp: time(), provider: "paperhub", modelId: "kimi-k3" };
  const eThinkLevel = { type: "thinking_level_change", id: id(), parentId: eModelChange.id, timestamp: time(), thinkingLevel: "high" };
  const eName = { type: "session_info", id: id(), parentId: eThinkLevel.id, timestamp: time(), name: "garden 开发会话" };

  const eUser1 = {
    type: "message",
    id: id(),
    parentId: eName.id,
    timestamp: time(),
    message: {
      role: "user",
      content: [
        { type: "text", text: USER_PROMPT_1 },
        { type: "image", data: "aGVsbG8=".repeat(100), mimeType: "image/png" },
      ],
      timestamp: ts,
    },
  };

  const eA1 = {
    type: "message",
    id: id(),
    parentId: eUser1.id,
    timestamp: time(),
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: THINKING_TEXT },
        { type: "text", text: INTERMEDIATE_TEXT },
        { type: "toolCall", id: "read:0", name: "read", arguments: { path: "/tmp/proj/package.json" } },
      ],
      provider: "paperhub",
      model: "kimi-k3",
      usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
      stopReason: "toolUse",
      timestamp: ts,
    },
  };

  const eR1 = {
    type: "message",
    id: id(),
    parentId: eA1.id,
    timestamp: time(),
    message: {
      role: "toolResult",
      toolCallId: "read:0",
      toolName: "read",
      content: [{ type: "text", text: LONG_RESULT }],
      details: { truncation: { content: READ_TRUNCATION_CONTENT, truncated: true, totalLines: 1000, outputLines: 20 } },
      isError: false,
      timestamp: ts,
    },
  };

  const eA2 = {
    type: "message",
    id: id(),
    parentId: eR1.id,
    timestamp: time(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "write:0", name: "write", arguments: { path: "/tmp/proj/big.txt", content: LONG_ARG } }],
      model: "kimi-k3",
      stopReason: "toolUse",
      timestamp: ts,
    },
  };

  const eR2 = {
    type: "message",
    id: id(),
    parentId: eA2.id,
    timestamp: time(),
    message: { role: "toolResult", toolCallId: "write:0", toolName: "write", content: [{ type: "text", text: "File written" }], isError: false, timestamp: ts },
  };

  const eA3 = {
    type: "message",
    id: id(),
    parentId: eR2.id,
    timestamp: time(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "bash:0", name: "bash", arguments: { command: "ls -la /tmp/proj" } }],
      model: "kimi-k3",
      stopReason: "toolUse",
      timestamp: ts,
    },
  };

  const eR3 = {
    type: "message",
    id: id(),
    parentId: eA3.id,
    timestamp: time(),
    message: {
      role: "toolResult",
      toolCallId: "bash:0",
      toolName: "bash",
      content: [{ type: "text", text: "boom error" }],
      details: {}, // 空 details：任何级别都不渲染
      isError: true,
      timestamp: ts,
    },
  };

  // edit 工具的 toolResult：details 含 diff/patch（独有信息），L1 保留
  const eEditCall = {
    type: "message",
    id: id(),
    parentId: eR3.id,
    timestamp: time(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "edit:0", name: "edit", arguments: { path: "/tmp/proj/a.svg", oldText: "x", newText: "y" } }],
      model: "kimi-k3",
      stopReason: "toolUse",
      timestamp: ts,
    },
  };

  const eEditResult = {
    type: "message",
    id: id(),
    parentId: eEditCall.id,
    timestamp: time(),
    message: {
      role: "toolResult",
      toolCallId: "edit:0",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.svg" }],
      details: { diff: EDIT_DIFF, patch: "--- a.svg\n+++ b.svg\n@@ -27,6 +27,6 @@", firstChangedLine: 31 },
      isError: false,
      timestamp: ts,
    },
  };

  const eA4 = {
    type: "message",
    id: id(),
    parentId: eEditResult.id,
    timestamp: time(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: FINAL_TEXT_T1 }],
      model: "kimi-k3",
      usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 2200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.5 } },
      stopReason: "stop",
      timestamp: ts,
    },
  };

  // 分支：parentId 指回 eA1（不是上一条 eA4）→ 应出现跳回提示
  const eUser2 = {
    type: "message",
    id: id(),
    parentId: eA1.id,
    timestamp: time(),
    message: { role: "user", content: [{ type: "text", text: "换个思路试试" }], timestamp: ts },
  };

  const eBranchSummary = {
    type: "branch_summary",
    id: id(),
    parentId: eUser2.id,
    timestamp: time(),
    fromId: eA4.id,
    summary: "之前分支：读取并总结了 package.json。",
  };

  const eA5 = {
    type: "message",
    id: id(),
    parentId: eBranchSummary.id,
    timestamp: time(),
    message: { role: "assistant", content: [{ type: "text", text: FINAL_TEXT_T2 }], model: "kimi-k3", stopReason: "stop", timestamp: ts },
  };

  const eBashExec = {
    type: "message",
    id: id(),
    parentId: eA5.id,
    timestamp: time(),
    message: { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false, timestamp: ts },
  };

  const eCustom = { type: "custom", id: id(), parentId: eBashExec.id, timestamp: time(), customType: "my-ext", data: { count: 1 } };

  const eCustomMsg = {
    type: "custom_message",
    id: id(),
    parentId: eCustom.id,
    timestamp: time(),
    customType: "my-ext",
    content: "注入的上下文信息",
    display: true,
  };

  const eLabel = { type: "label", id: id(), parentId: eCustomMsg.id, timestamp: time(), targetId: eUser1.id, label: "checkpoint-1" };

  const eCompaction = {
    type: "compaction",
    id: id(),
    parentId: eLabel.id,
    timestamp: time(),
    summary: COMPACTION_SUMMARY,
    tokensBefore: 12345,
    details: { readFiles: ["/tmp/proj/package.json"], modifiedFiles: ["/tmp/proj/big.txt"] },
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  };

  const eUser3 = {
    type: "message",
    id: id(),
    parentId: eCompaction.id,
    timestamp: time(),
    message: { role: "user", content: "最后确认一下状态" },
  };

  const eA6 = {
    type: "message",
    id: id(),
    parentId: eUser3.id,
    timestamp: time(),
    message: { role: "assistant", content: [{ type: "text", text: FINAL_TEXT_T3 }], model: "kimi-k3", stopReason: "stop", timestamp: ts },
  };

  return {
    header,
    entries: [
      eModelChange, eThinkLevel, eName, eUser1, eA1, eR1, eA2, eR2, eA3, eR3,
      eEditCall, eEditResult, eA4, eUser2, eBranchSummary, eA5, eBashExec, eCustom, eCustomMsg, eLabel,
      eCompaction, eUser3, eA6,
    ],
  };
}

export function buildSampleJsonl(): string {
  const { header, entries } = buildSample();
  return [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
}
