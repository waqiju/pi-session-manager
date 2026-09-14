/** 手工构造的 session fixture：覆盖全部 entry 类型 + 分支跳回 + compaction */

/** 每次 buildSample 调用前复位，保证输出确定（可重复构造相同 fixture） */
let seq = 0;
let ts = 0;
const id = () => `id${String(++seq).padStart(6, "0")}`;
const time = () => new Date((ts += 1000)).toISOString();

const LONG_RESULT = "HEAD_MARKER\n" + "x".repeat(5000) + "\nTAIL_MARKER";
const LONG_ARG = "W".repeat(3000);
export const THINKING_TEXT = "让我想想这个问题怎么处理，先读文件再总结。";
export const INTERMEDIATE_TEXT = "我先读取一下这个文件";
export const FINAL_TEXT_T1 = "完成了：文件内容是一个测试包配置。";
export const FINAL_TEXT_T2 = "好的，换个思路来做。";
export const FINAL_TEXT_T3 = "最终回答：全部搞定。";
export const USER_PROMPT_1 = "请读取 package.json 并总结";
export const COMPACTION_SUMMARY = "## Goal\n测试压缩摘要：用户在做 garden 工具开发。";

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
    message: { role: "toolResult", toolCallId: "bash:0", toolName: "bash", content: [{ type: "text", text: "boom error" }], isError: true, timestamp: ts },
  };

  const eA4 = {
    type: "message",
    id: id(),
    parentId: eR3.id,
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
      eA4, eUser2, eBranchSummary, eA5, eBashExec, eCustom, eCustomMsg, eLabel,
      eCompaction, eUser3, eA6,
    ],
  };
}

export function buildSampleJsonl(): string {
  const { header, entries } = buildSample();
  return [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
}
