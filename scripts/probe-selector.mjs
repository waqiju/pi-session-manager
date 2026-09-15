/**
 * /garden 选择器 headless 验证工具。
 *
 * 不开 TUI，用真实 sessions 数据驱动 pi 官方 SessionSelectorComponent，验证：
 *   - loader 数据形状（SessionInfo 鸭子类型）满足组件渲染/树构建/搜索
 *   - garden 富化覆盖（name / messageCount / allMessagesText 语料）
 *   - 加载耗时与语料体积
 *
 * 用法：node scripts/probe-selector.mjs [sessionsRoot]
 * 依赖：全局安装的 @earendil-works/pi-coding-agent（按 PI_PACKAGE 定位）。
 * 注意：只读操作，不写任何文件。
 */
import path from "node:path";
import os from "node:os";
import { readdirSync } from "node:fs";
import { listProjectSessions, listAllSessions } from "../src/session-list.ts";

const PI_PACKAGE = process.env.PI_PACKAGE ??
  "/home/adam/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent";
const { SessionSelectorComponent } = await import(`${PI_PACKAGE}/dist/index.js`);
const { KeybindingsManager } = await import(`${PI_PACKAGE}/dist/core/keybindings.js`);
const { initTheme } = await import(`${PI_PACKAGE}/dist/modes/interactive/theme/theme.js`);
const { filterAndSortSessions } = await import(`${PI_PACKAGE}/dist/modes/interactive/components/session-selector-search.js`);
initTheme("dark");

const sessionsRoot = process.argv[2] ?? path.join(os.homedir(), ".pi", "agent", "sessions");

// 选文件最多的真实 sessionDir 当 current scope
const subs = readdirSync(sessionsRoot, { withFileTypes: true })
  .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
  .map((d) => d.name);
const counts = subs.map((s) => [s, readdirSync(path.join(sessionsRoot, s)).filter((f) => f.endsWith(".jsonl")).length]);
counts.sort((a, b) => b[1] - a[1]);
if (counts.length === 0) {
  console.error("no session subdirs under", sessionsRoot);
  process.exit(1);
}
const currentDir = path.join(sessionsRoot, counts[0][0]);
console.log("sessionsRoot:", sessionsRoot, "| subdirs:", subs.length, "| currentDir:", counts[0][0], `(${counts[0][1]} files)`);

let progressEvents = 0;
const onProgress = () => void progressEvents++;
const selector = new SessionSelectorComponent(
  (p) => listProjectSessions(currentDir, { onProgress: (l, t) => { progressEvents++; p?.(l, t); } }),
  (p) => listAllSessions(sessionsRoot, { onProgress: (l, t) => { progressEvents++; p?.(l, t); } }),
  (p) => console.log("[onSelect]", p),
  () => console.log("[onCancel]"),
  () => console.log("[onExit]"),
  () => {},
  { keybindings: KeybindingsManager.create(), showRenameHint: true, renameSession: async () => {} },
  undefined,
);
await new Promise((r) => setTimeout(r, 10_000)); // 等构造里的 loadCurrentSessions 落地

const list = selector.getSessionList();
const lines = list.render(120);
console.log(`\n--- render (current scope, ${lines.length} lines, ANSI 已剥离) ---`);
for (const l of lines) console.log(l.replace(/\x1b\[[0-9;]*m/g, ""));

const sessions = list.allSessions ?? [];
const pathSet = new Set(sessions.map((s) => s.path));
const withParent = sessions.filter((s) => s.parentSessionPath);
console.log(`\nitems=${sessions.length} fork=${withParent.length} danglingParent=${withParent.filter((s) => !pathSet.has(s.parentSessionPath)).length}`);
console.log(`empty title=${sessions.filter((s) => !s.name && !s.firstMessage).length} progressEvents=${progressEvents}`);

// current scope 语料与搜索
const textBytes = sessions.reduce((n, s) => n + s.allMessagesText.length, 0);
console.log(`allMessagesText 覆盖: ${sessions.filter((s) => s.allMessagesText).length}/${sessions.length}，语料 ${(textBytes / 1024 / 1024).toFixed(1)}MB`);

// all scope 冒烟 + 计时
const t1 = Date.now();
const allItems = await listAllSessions(sessionsRoot, { onProgress });
const allBytes = allItems.reduce((n, s) => n + s.allMessagesText.length, 0);
console.log(`all scope: ${allItems.length} items in ${Date.now() - t1}ms，语料 ${(allBytes / 1024 / 1024).toFixed(1)}MB`);
console.log(`firstMessage 兜底 "(no messages)": ${allItems.filter((s) => s.firstMessage === "(no messages)").length}`);
