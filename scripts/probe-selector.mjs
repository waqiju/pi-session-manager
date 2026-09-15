/**
 * /garden 选择器 headless 验证工具。
 *
 * 不开 TUI，用真实 garden 产物驱动自绘 GardenSelectorComponent，验证：
 *   - md-sourced loader（frontmatter 解析 / fork 树 / 全文语料）
 *   - 加载与渲染耗时（drvfs 性能回归探针：内建组件在此数据上首次渲染 ≈22s，
 *     本组件预算 <3s 加载 + <100ms 首次渲染）
 *   - 按键驱动（搜索 / scope 切换 / 树渲染 / 选中）
 *
 * 用法：node scripts/probe-selector.mjs [gardenRoot]
 * 依赖：全局安装的 @earendil-works/pi-coding-agent（仅借它的 KeybindingsManager 做真实按键匹配）。
 * 注意：只读操作，不写任何文件。
 */
import path from "node:path";
import os from "node:os";
import { readdirSync } from "node:fs";
import { listProjectSessions, listAllSessions, gardenRootForSessionDir } from "../src/session-list.ts";
import { GardenSelectorComponent } from "../extensions/garden-selector.ts";
import { stripAnsi } from "../src/textwidth.ts";

const PI_PACKAGE = process.env.PI_PACKAGE ??
  "/home/adam/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent";
const { KeybindingsManager } = await import(`${PI_PACKAGE}/dist/core/keybindings.js`);
const { initTheme, theme } = await import(`${PI_PACKAGE}/dist/modes/interactive/theme/theme.js`);
initTheme("dark");

const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
const gardenRoot = process.argv[2] ?? gardenRootForSessionDir(path.join(sessionsRoot, "x"));

// 选 md 最多的子目录当 current scope
const subs = readdirSync(gardenRoot, { withFileTypes: true })
  .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
  .map((d) => d.name);
const counts = subs.map((s) => [s, readdirSync(path.join(gardenRoot, s)).filter((f) => f.endsWith(".md")).length]);
counts.sort((a, b) => b[1] - a[1]);
if (counts.length === 0) {
  console.error("no garden subdirs under", gardenRoot);
  process.exit(1);
}
const currentGardenDir = path.join(gardenRoot, counts[0][0]);
console.log("gardenRoot:", gardenRoot, "| subdirs:", subs.length, "| currentDir:", counts[0][0], `(${counts[0][1]} md files)`);

const keybindings = KeybindingsManager.create();
let selected = null;
const t0 = performance.now();
const selector = new GardenSelectorComponent({
  theme,
  keybindings,
  requestRender: () => {},
  loadCurrent: (onProgress) => listProjectSessions(currentGardenDir, { onProgress }),
  loadAll: (onProgress) => listAllSessions(gardenRoot, { onProgress }),
  onSelect: (p) => (selected = p),
  onCancel: () => {},
  renameSession: async () => undefined,
  deleteSession: async () => ({ ok: true }),
});
// 等加载落地（轮询渲染内容而非拍脑袋 sleep）
for (let i = 0; i < 600; i++) {
  await new Promise((r) => setTimeout(r, 100));
  const text = selector.render(120).map((l) => stripAnsi(l)).join("\n");
  if (!text.includes("加载中") && !text.includes("Loading")) break;
}
const loadMs = performance.now() - t0;

const t1 = performance.now();
const lines = selector.render(120).map((l) => stripAnsi(l));
const renderMs = performance.now() - t1;

console.log(`\n--- render (current scope, ${lines.length} lines) ---`);
for (const l of lines) console.log(l);

// fork 树断言：渲染里应出现分支符（真实数据里有 fork 链）
const treeLines = lines.filter((l) => l.includes("├─") || l.includes("└─"));
console.log(`\nfork 树分支行: ${treeLines.length}`);

// 按键驱动：搜索
for (const ch of "garden") selector.handleInput(ch);
const searched = selector.render(120).map((l) => stripAnsi(l));
console.log(`搜索 "garden" 后行数: ${searched.length}`);
for (let i = 0; i < 6; i++) selector.handleInput("\x7f");

// Tab → all scope
selector.handleInput("\t");
const tAll = performance.now();
for (let i = 0; i < 600; i++) {
  await new Promise((r) => setTimeout(r, 100));
  const text = selector.render(120).map((l) => stripAnsi(l)).join("\n");
  if (!text.includes("Loading")) break;
}
const allMs = performance.now() - tAll;
const allLines = selector.render(120).map((l) => stripAnsi(l));
console.log(`\n--- all scope (${allLines.length} lines) ---`);
for (const l of allLines.slice(0, 14)) console.log(l);

// Enter 选中第一条
selector.handleInput("\r");

console.log("\n===== 结果 =====");
console.log(`current scope 加载: ${loadMs.toFixed(0)}ms | 首次渲染: ${renderMs.toFixed(1)}ms | all scope 加载: ${allMs.toFixed(0)}ms`);
console.log(`选中: ${selected ?? "(无)"}`);
const budget = loadMs < 5000 && renderMs < 100 && allMs < 8000;
console.log(budget ? "PASS（远低于内建组件 drvfs 上 ~22s 的基线）" : "FAIL: 超出性能预算");
process.exit(selected && budget ? 0 : 1);
