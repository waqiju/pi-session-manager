/**
 * garden 自绘 session 选择器 —— 替代 pi 的 SessionSelectorComponent。
 *
 * 动机（pi 0.85.1 实测）：内建组件 buildSessionTree 对每个 session 调 3 次
 * canonicalizePath（= realpathSync），`~/.pi/agent/sessions` 是 drvfs symlink 时
 * ~23ms/次：315 session 首次渲染 ≈ 22s，且搜索清空 / 切 scope / 删除重命名后重付。
 * 本组件零 realpath：fork 树按文件名配对（session-tree.ts），列表数据全部来自
 * garden md（session-list.ts），315 session 加载 ≈ 2-3s、渲染与按键 <50ms。
 *
 * 零运行时 pi 依赖（node --test 可直测）：theme / keybindings 由 ctx.ui.custom
 * 工厂注入，只需满足下面的结构化接口（pi 的 Theme / KeybindingsManager 天然满足）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { indexOutputsBySessionId } from "../src/cli.ts";
import { GARDEN_LEVELS } from "../src/open.ts";
import type { SessionListItem } from "../src/session-list.ts";
import {
  buildSessionTree,
  filterAndSortSessions,
  flattenSessionTree,
  parseSearchQuery,
  type FlatNode,
  type TreeNode,
} from "../src/session-tree.ts";
import { truncateToWidth, visibleWidth } from "../src/textwidth.ts";

/** pi-tui 的硬件光标定位标记（IME 用）；内联以避免运行时依赖 pi 包 */
const CURSOR_MARKER = "\x1b_pi:c\x07";

/** 结构化主题接口：pi 的 Theme 类直接满足（方法参数双变） */
export interface SelectorTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** 结构化按键接口：pi 的 KeybindingsManager.matches 直接满足 */
export interface SelectorKeybindings {
  matches(data: string, action: string): boolean;
}

export interface SelectorOptions {
  theme: SelectorTheme;
  keybindings: SelectorKeybindings;
  requestRender: () => void;
  /** 当前 session 的 jsonl 路径（高亮 + 禁止删除）；ephemeral 会话无 */
  currentFilePath?: string;
  loadCurrent: (onProgress: (loaded: number, total: number) => void) => Promise<SessionListItem[]>;
  loadAll: (onProgress: (loaded: number, total: number) => void) => Promise<SessionListItem[]>;
  onSelect: (path: string) => void;
  onCancel: () => void;
  /** 重命名（pi SessionManager.appendSessionInfo 同路径）；成功返回新 mdBase（可选） */
  renameSession?: (item: SessionListItem, name: string) => Promise<string | undefined>;
  /** 新建子 session（parentSession = 选中项；空 session，pi 自动切换过去） */
  onNewChild?: (item: SessionListItem) => void;
  /** 复制文本到系统剪贴板（平台命令注入；组件自持 toast 反馈） */
  copyToClipboard?: (text: string) => { ok: boolean; error?: string };
  /** 删除（jsonl + garden md 产物）；返回 ok/error */
  deleteSession?: (item: SessionListItem) => Promise<{ ok: boolean; error?: string }>;
  /** 终端高度（可选，用于自适应 maxVisible）；不传则回退 process.stdout.rows / 24 */
  getTerminalHeight?: () => number;
  maxVisible?: number;
}

// ---------- 显示小工具 ----------

function shortenPath(p: string): string {
  const home = os.homedir();
  return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** 相对时间（与内建 formatSessionDate 一致：now/m/h/d/w/mo/y） */
export function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
}

function treePrefix(node: FlatNode): string {
  if (node.depth === 0) return "";
  const parts = node.ancestorContinues.map((c) => (c ? "│  " : "   "));
  return parts.join("") + (node.isLast ? "└─ " : "├─ ");
}

// ---------- 极简行输入（搜索框 / 重命名框共用） ----------

/**
 * 单行文本编辑：可打印字符插入（含粘贴整段）、backspace/delete、左右/Home/End、
 * ctrl+a/e/u/k/w。按 code point 操作（不劈开代理对）。不处理 escape 序列以外的
 * 控制字符；不认识的一律不消费（交回调用方）。
 */
export class LineInput {
  private chars: string[] = [];
  private cursor = 0;

  getValue(): string {
    return this.chars.join("");
  }

  setValue(v: string): void {
    this.chars = Array.from(v);
    this.cursor = this.chars.length;
  }

  /** 返回 true = 按键被消费（文本可能变了） */
  handleInput(data: string): boolean {
    if (data === "\x7f") {
      // backspace
      if (this.cursor === 0) return true;
      this.chars.splice(this.cursor - 1, 1);
      this.cursor--;
      return true;
    }
    if (data === "\x1b[3~") {
      // delete
      if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
      return true;
    }
    if (data === "\x1b[D") {
      this.cursor = Math.max(0, this.cursor - 1);
      return true;
    }
    if (data === "\x1b[C") {
      this.cursor = Math.min(this.chars.length, this.cursor + 1);
      return true;
    }
    if (data === "\x1b[H" || data === "\x01") {
      this.cursor = 0;
      return true;
    }
    if (data === "\x1b[F" || data === "\x05") {
      this.cursor = this.chars.length;
      return true;
    }
    if (data === "\x15") {
      // ctrl+u：删到行首
      this.chars.splice(0, this.cursor);
      this.cursor = 0;
      return true;
    }
    if (data === "\x0b") {
      // ctrl+k：删到行尾
      this.chars.length = this.cursor;
      return true;
    }
    if (data === "\x17") {
      // ctrl+w：删前一个词
      let i = this.cursor;
      while (i > 0 && this.chars[i - 1] === " ") i--;
      while (i > 0 && this.chars[i - 1] !== " ") i--;
      this.chars.splice(i, this.cursor - i);
      this.cursor = i;
      return true;
    }
    if (data.startsWith("\x1b")) return false; // 不认识的 escape 序列不消费
    // 可打印输入（含中文等宽字符、粘贴的整段文本）：剥掉控制字符，换行变空格
    const cleaned = data.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
    if (!cleaned) return false;
    this.chars.splice(this.cursor, 0, ...Array.from(cleaned));
    this.cursor += Array.from(cleaned).length;
    return true;
  }

  /** 渲染为一行：prompt + 文本；聚焦时光标处嵌 CURSOR_MARKER；超宽时窗口跟随光标 */
  render(width: number, prompt: string, focused = true): string {
    const budget = Math.max(1, width - visibleWidth(prompt));
    const before = this.chars.slice(0, this.cursor).join("");
    const after = this.chars.slice(this.cursor).join("");
    const marker = focused ? CURSOR_MARKER : "";
    let text = before + marker + after;
    if (visibleWidth(before) + visibleWidth(after) > budget) {
      // 光标左侧优先占满预算（搜索框场景光标通常在尾部）
      const b = truncateToWidth(before, budget - 1, "");
      const head = visibleWidth(b) < visibleWidth(before) ? "…" + b : b;
      text = truncateToWidth(head + marker + after, width - visibleWidth(prompt), "");
    }
    return prompt + text;
  }
}

// ---------- 文件删除（jsonl trash/unlink + garden md 清理） ----------

/** 删除 session jsonl：先试 trash CLI，失败回退 unlink（对齐内建 /resume 删除语义） */
export async function deleteSessionFile(sessionPath: string): Promise<{ ok: boolean; error?: string }> {
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
  if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true };
  try {
    await unlink(sessionPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 删除该 session 的全部 garden 产物：按 frontmatter session_id 反查（不认文件名），
 * 改名/重编号残留一并清掉，保证下次列表不再出现。
 */
export async function deleteGardenOutputs(item: SessionListItem): Promise<number> {
  const files = indexOutputsBySessionId(item.mdDir).get(JSON.stringify(item.id)) ?? [];
  let removed = 0;
  for (const f of files) {
    try {
      await unlink(path.join(item.mdDir, f));
      removed++;
    } catch {
      /* ignore */
    }
  }
  // 保底：按当前 base 直删（frontmatter 损坏的文件 indexOutputsBySessionId 索引不到）
  for (const level of GARDEN_LEVELS) {
    try {
      await unlink(path.join(item.mdDir, `${item.mdBase}.${level}.md`));
    } catch {
      /* ignore */
    }
  }
  return removed;
}

// ---------- Ctrl+字母 匹配（编码无关） ----------

/** Kitty 协议修饰键里的 Lock 位（Caps Lock + Num Lock），对齐 pi-tui keys.js 的 LOCK_MASK */
const KITTY_LOCK_MASK = 64 + 128;

/**
 * Ctrl+<letter> 判定，与 pi-tui matchesKey(data, "ctrl+<letter>") 等价但内联，保持本文件零 pi 依赖。
 * 覆盖三种终端编码（以 ctrl+n 为例）：
 *   legacy          → "\x0e"（控制字符：letter charCode & 0x1f）
 *   Kitty CSI-u     → "\x1b[110;5u"（可带 alternate keys / event type 段；pi-tui 协商 flags=7）
 *   modifyOtherKeys → "\x1b[27;5;110~"（Kitty 不可用时的回退）
 * 不走 kb.matches("app.session.*")：pi 0.85.1 把 ctrl+n 默认绑定从 app.session.new 挪给
 * toggleNamedFilter 已证明上游会改绑；且 pi 的 KeybindingsManager 不认扩展自定义 action，
 * 用户配置无法补绑。garden 选择器的自有快捷键直接认物理键。
 */
export function isCtrlLetter(data: string, letter: string): boolean {
  const code = letter.charCodeAt(0); // 期望 a-z
  if (data === String.fromCharCode(code & 0x1f)) return true;
  if (data === `\x1b[27;5;${code}~`) return true;
  // CSI-u：\x1b[<codepoint>[:shifted[:base]]][;<mod>[:event]]u；mod 值 = 修饰位 + 1，ctrl = 4
  const m = data.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/);
  if (!m) return false;
  const modifier = m[2] === undefined ? 0 : Number(m[2]) - 1;
  return Number(m[1]) === code && (modifier & ~KITTY_LOCK_MASK) === 4;
}

// ---------- 子树复制（树 + l3 路径清单，粘贴给 AI 作 context） ----------

/** 子树复制上限（防误把巨型树塞进剪贴板；超出硬拒，不截断） */
export const COPY_SUBTREE_MAX = 99;

/** 文件大小标签：500B / 8KB / 1.2MB；null（文件不存在等）→ "?" */
export function formatSizeLabel(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 子树复制文本：树形（name + msgs）+ l3 路径清单（~ 缩短 + size + msgs）。
 * flat = flattenSessionTree([子树根]) 的结果（depth 相对子树根）。
 * sizeOf 注入文件 stat（组件用 statSync，测试传 stub）；只 stat 不读正文。
 * l3 文件可能不存在（导出级别未含 l3）→ size "?"；路径照列（提示行已说明 l1 同名）。
 */
export function buildSubtreeCopyText(flat: FlatNode[], sizeOf: (absPath: string) => number | null): string {
  const lines: string[] = ["## Garden Session Subtree", ""];
  flat.forEach((n, i) => {
    const s = n.session;
    const name = (s.name?.replace(/[\x00-\x1f\x7f]/g, " ").trim() ?? "") || "untitled";
    if (i === 0) {
      lines.push(`根: ${name} (${s.messageCount} msgs)`);
      return;
    }
    // 前缀跳过 ancestorContinues 首槽（子树根一级，屏幕上用于缩进对齐，导出文本顶格即可）
    const parts = n.ancestorContinues.slice(1).map((c) => (c ? "│  " : "   "));
    lines.push(`${parts.join("")}${n.isLast ? "└─ " : "├─ "}${name} (${s.messageCount} msgs)`);
  });
  lines.push("", "文件路径（l3 = 纯问答视图；同名 .l1.md 含工具细节和完整推理）:");
  for (const n of flat) {
    const s = n.session;
    const abs = path.join(s.mdDir, `${s.mdBase}.l3.md`);
    lines.push(`  ${shortenPath(abs)}  ${formatSizeLabel(sizeOf(abs))}  ${s.messageCount} msgs`);
  }
  return lines.join("\n") + "\n";
}

/**
 * 平台剪贴板复制：pbcopy（macOS）/ clip.exe（WSL）/ wl-copy（Wayland）/ xclip（X11）。
 * spawnSync 同步喂 stdin，3s 超时；全部不可用返回 error 供选择器 toast。
 */
export function copyToClipboard(text: string): { ok: boolean; error?: string } {
  const cmds: [string, string[]][] = [];
  if (process.platform === "darwin") {
    cmds.push(["pbcopy", []]);
  } else if (process.env.WSL_DISTRO_NAME) {
    cmds.push(["clip.exe", []]);
  } else {
    if (process.env.WAYLAND_DISPLAY) cmds.push(["wl-copy", []]);
    cmds.push(["xclip", ["-selection", "clipboard"]]);
  }
  for (const [cmd, args] of cmds) {
    try {
      const r = spawnSync(cmd, args, { input: text, timeout: 3000 });
      if (r.status === 0) return { ok: true };
    } catch {
      /* 命令不存在等，试下一个 */
    }
  }
  return { ok: false, error: "无可用剪贴板命令（尝试 pbcopy/clip.exe/xclip/wl-copy）" };
}

// ---------- 选择器组件 ----------

type Scope = "current" | "all";
type Mode = "list" | "rename";

export class GardenSelectorComponent {
  private theme: SelectorTheme;
  private keybindings: SelectorKeybindings;
  private requestRender: () => void;
  private opts: SelectorOptions;

  private scope: Scope = "current";
  private mode: Mode = "list";
  private items: Record<Scope, SessionListItem[] | null> = { current: null, all: null };
  private loading: Record<Scope, boolean> = { current: false, all: false };
  private progress: { loaded: number; total: number } | null = null;
  private loadSeq: Record<Scope, number> = { current: 0, all: 0 };

  private searchInput = new LineInput();
  private renameInput = new LineInput();
  private renameTarget: SessionListItem | null = null;
  private confirmingDelete: SessionListItem | null = null;
  private flat: FlatNode[] = [];
  private selectedIndex = 0;
  private statusMessage: { type: "info" | "error"; message: string } | null = null;
  private statusTimeout: ReturnType<typeof setTimeout> | null = null;
  private maxVisible: number;
  private queryError: string | null = null;

  /** Focusable：TUI 聚焦时置位；聚焦才输出硬件光标标记 */
  focused = true;

  constructor(opts: SelectorOptions) {
    this.opts = opts;
    this.theme = opts.theme;
    this.keybindings = opts.keybindings;
    this.requestRender = opts.requestRender;
    const height = opts.getTerminalHeight?.() ?? process.stdout.rows ?? 24;
    this.maxVisible = opts.maxVisible ?? Math.max(8, height - 10); // 上下留白 ≈ 行（border×2 + header + search + blank + hints）
    void this.loadScope("current");
  }

  invalidate(): void {
    /* 无渲染缓存 */
  }

  dispose(): void {
    if (this.statusTimeout) clearTimeout(this.statusTimeout);
  }

  // ----- 数据加载 -----

  private async loadScope(scope: Scope): Promise<void> {
    const seq = ++this.loadSeq[scope];
    this.loading[scope] = true;
    if (scope === this.scope) {
      this.progress = null;
      this.requestRender();
    }
    const onProgress = (loaded: number, total: number): void => {
      if (scope !== this.scope || seq !== this.loadSeq[scope]) return;
      this.progress = { loaded, total };
      this.requestRender();
    };
    try {
      const loader = scope === "current" ? this.opts.loadCurrent : this.opts.loadAll;
      const items = await loader(onProgress);
      if (seq !== this.loadSeq[scope]) return; // 过期加载结果丢弃
      this.items[scope] = items;
      this.loading[scope] = false;
      if (scope !== this.scope) return;
      this.progress = null;
      this.refilter();
      this.requestRender();
    } catch (err) {
      if (seq !== this.loadSeq[scope]) return;
      this.loading[scope] = false;
      if (scope !== this.scope) return;
      this.progress = null;
      this.setStatus(`加载失败: ${err instanceof Error ? err.message : String(err)}`, "error", 4000);
      this.items[scope] = this.items[scope] ?? [];
      this.refilter();
      this.requestRender();
    }
  }

  private toggleScope(): void {
    this.scope = this.scope === "current" ? "all" : "current";
    this.progress = null;
    if (this.items[this.scope] === null && !this.loading[this.scope]) {
      void this.loadScope(this.scope);
    } else {
      this.refilter();
    }
    this.requestRender();
  }

  /** 按当前 scope + 搜索词重建显示列表（空查询 = fork 树，非空 = 平铺搜索结果） */
  private refilter(): void {
    const items = this.items[this.scope] ?? [];
    const query = this.searchInput.getValue().trim();
    this.queryError = null;
    if (!query) {
      this.flat = flattenSessionTree(buildSessionTree(items));
    } else {
      const parsed = parseSearchQuery(query);
      if (parsed.mode === "regex" && parsed.error) this.queryError = parsed.error;
      this.flat = filterAndSortSessions(items, query).map((session) => ({
        session,
        depth: 0,
        isLast: true,
        ancestorContinues: [],
      }));
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.flat.length - 1));
  }

  // ----- 状态与提示 -----

  private setStatus(message: string | null, type: "info" | "error" = "info", autoHideMs = 0): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    this.statusMessage = message ? { type, message } : null;
    if (message && autoHideMs) {
      this.statusTimeout = setTimeout(() => {
        this.statusMessage = null;
        this.statusTimeout = null;
        this.requestRender();
      }, autoHideMs);
    }
  }

  private isCurrent(item: SessionListItem): boolean {
    return !!this.opts.currentFilePath && item.path === this.opts.currentFilePath;
  }

  // ----- 删除 / 重命名 -----

  private async doDelete(item: SessionListItem): Promise<void> {
    if (!this.opts.deleteSession) return;
    const result = await this.opts.deleteSession(item);
    if (result.ok) {
      for (const scope of ["current", "all"] as const) {
        const list = this.items[scope];
        if (list) this.items[scope] = list.filter((s) => s.path !== item.path);
      }
      this.refilter();
      this.setStatus("Session deleted", "info", 2000);
    } else {
      this.setStatus(`删除失败: ${result.error ?? "未知错误"}`, "error", 3000);
    }
    this.requestRender();
  }

  private async doRename(name: string): Promise<void> {
    const target = this.renameTarget;
    this.mode = "list";
    this.renameTarget = null;
    if (!target || !this.opts.renameSession) return;
    const next = name.trim();
    if (!next) {
      this.requestRender();
      return;
    }
    try {
      const newBase = await this.opts.renameSession(target, next);
      target.name = next;
      if (newBase) target.mdBase = newBase;
      this.refilter();
      this.setStatus("已重命名", "info", 2000);
    } catch (err) {
      this.setStatus(`重命名失败: ${err instanceof Error ? err.message : String(err)}`, "error", 3000);
    }
    this.requestRender();
  }

  // ----- 子树复制 -----

  private doCopySubtree(): void {
    if (!this.opts.copyToClipboard) return;
    const selected = this.flat[this.selectedIndex];
    if (!selected) return;
    // 从当前 scope 全量 items 重建树（纯 Map 操作，亚毫秒），按对象同一性定位选中节点；
    // 搜索态下 flat 是平铺结果，子树仍从全量树取（语义：复制完整后代链）
    const roots = buildSessionTree(this.items[this.scope] ?? []);
    const find = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const n of nodes) {
        if (n.session === selected.session) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return undefined;
    };
    const node = find(roots);
    if (!node) return; // 不会发生：selected 来自当前 items
    const subtree = flattenSessionTree([node]);
    if (subtree.length > COPY_SUBTREE_MAX) {
      this.setStatus(`子树过大（${subtree.length}>${COPY_SUBTREE_MAX}），请缩小范围`, "error", 3000);
      this.requestRender();
      return;
    }
    const text = buildSubtreeCopyText(subtree, (p) => {
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    });
    const r = this.opts.copyToClipboard(text);
    if (r.ok) {
      this.setStatus(`已复制 ${subtree.length} 个 session 到剪贴板`, "info", 2000);
    } else {
      this.setStatus(`复制失败: ${r.error ?? "未知错误"}`, "error", 4000);
    }
    this.requestRender();
  }

  // ----- 输入分发 -----

  handleInput(data: string): void {
    const kb = this.keybindings;
    // 删除确认态：吞掉所有其他键
    if (this.confirmingDelete) {
      if (kb.matches(data, "tui.select.confirm")) {
        const target = this.confirmingDelete;
        this.confirmingDelete = null;
        void this.doDelete(target);
      } else if (kb.matches(data, "tui.select.cancel")) {
        this.confirmingDelete = null;
      }
      this.requestRender();
      return;
    }
    if (this.mode === "rename") {
      if (kb.matches(data, "tui.select.cancel")) {
        this.mode = "list";
        this.renameTarget = null;
        this.requestRender();
        return;
      }
      if (kb.matches(data, "tui.select.confirm")) {
        void this.doRename(this.renameInput.getValue());
        return;
      }
      if (this.renameInput.handleInput(data)) this.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = Math.min(this.flat.length - 1, this.selectedIndex + 1);
    } else if (kb.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
    } else if (kb.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(this.flat.length - 1, this.selectedIndex + this.maxVisible);
    } else if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.flat[this.selectedIndex];
      if (selected) {
        this.setStatus(null);
        this.opts.onSelect(selected.session.path);
        return; // done() 后组件即销毁，不再渲染
      }
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.setStatus(null);
      this.opts.onCancel();
      return;
    } else if (kb.matches(data, "tui.input.tab")) {
      this.toggleScope();
      return;
    } else if (this.opts.renameSession && kb.matches(data, "app.session.rename")) {
      const selected = this.flat[this.selectedIndex];
      if (selected) {
        this.mode = "rename";
        this.renameTarget = selected.session;
        this.renameInput.setValue(selected.session.name ?? "");
      }
    } else if (this.opts.deleteSession && kb.matches(data, "app.session.delete")) {
      const selected = this.flat[this.selectedIndex];
      if (selected) {
        if (this.isCurrent(selected.session)) {
          this.setStatus("不能删除当前活跃 session", "error", 3000);
        } else {
          this.confirmingDelete = selected.session;
        }
      }
    } else if (this.opts.onNewChild && isCtrlLetter(data, "n")) {
      const selected = this.flat[this.selectedIndex];
      if (selected) {
        this.setStatus(null);
        this.opts.onNewChild(selected.session);
        return;
      }
    } else if (this.opts.copyToClipboard && isCtrlLetter(data, "y")) {
      this.doCopySubtree();
      return; // doCopySubtree 自渲染
    } else {
      if (this.searchInput.handleInput(data)) this.refilter();
    }
    this.requestRender();
  }

  // ----- 渲染 -----

  private border(width: number): string {
    return this.theme.fg("accent", "─".repeat(Math.max(1, width)));
  }

  private renderHeader(width: number): string[] {
    const title = this.theme.bold(this.scope === "current" ? "garden Sessions (Current Folder)" : "garden Sessions (All)");
    let scopeText: string;
    if (this.loading[this.scope]) {
      const p = this.progress;
      scopeText = this.theme.fg("accent", `Loading ${p ? `${p.loaded}/${p.total}` : "..."}`);
    } else if (this.scope === "current") {
      scopeText = this.theme.fg("accent", "◉ Current Folder") + this.theme.fg("muted", " | ○ All");
    } else {
      scopeText = this.theme.fg("muted", "○ Current Folder | ") + this.theme.fg("accent", "◉ All");
    }
    const right = truncateToWidth(scopeText, width, "");
    const leftW = Math.max(0, width - visibleWidth(right) - 1);
    const left = truncateToWidth(title, leftW, "");
    const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
    return [`${left}${" ".repeat(spacing)}${right}`];
  }

  private renderHint(width: number): string {
    if (this.confirmingDelete) {
      return this.theme.fg("error", truncateToWidth(`Delete session? Enter confirm · Esc cancel`, width, "…"));
    }
    if (this.queryError) {
      return this.theme.fg("error", truncateToWidth(`正则无效: ${this.queryError}`, width, "…"));
    }
    if (this.statusMessage) {
      const color = this.statusMessage.type === "error" ? "error" : "accent";
      return this.theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
    }
    const hints = ['Tab scope · re:<正则> · "精确短语"', "Enter 切换 · Esc 取消"];
    if (this.opts.onNewChild) hints.push("Ctrl+N 新建子会话");
    if (this.opts.copyToClipboard) hints.push("Ctrl+Y 复制子树");
    if (this.opts.renameSession) hints.push("Ctrl+R 改名");
    if (this.opts.deleteSession) hints.push("Ctrl+D 删除");
    return this.theme.fg("muted", truncateToWidth(hints.join(" · "), width, "…"));
  }

  private renderRow(width: number, node: FlatNode, isSelected: boolean): string {
    const s = node.session;
    const isConfirming = this.confirmingDelete?.path === s.path;
    const isCurrent = this.isCurrent(s);
    const prefix = treePrefix(node);
    const displayText = (s.name ?? s.firstMessage).replace(/[\x00-\x1f\x7f]/g, " ").trim();
    let rightPart = `${s.messageCount} ${formatAge(s.modified)}`;
    if (this.scope === "all" && s.cwd) rightPart = `${shortenPath(s.cwd)} ${rightPart}`;
    const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
    const availableForMsg = Math.max(10, width - 2 - visibleWidth(prefix) - visibleWidth(rightPart) - 2);
    const truncatedMsg = truncateToWidth(displayText, availableForMsg, "…");
    let msgColor: string | null = null;
    if (isConfirming) msgColor = "error";
    else if (isCurrent) msgColor = "accent";
    else if (s.name) msgColor = "warning";
    let styledMsg = msgColor ? this.theme.fg(msgColor, truncatedMsg) : truncatedMsg;
    if (isSelected) styledMsg = this.theme.bold(styledMsg);
    const leftPart = cursor + this.theme.fg("dim", prefix) + styledMsg;
    const spacing = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(rightPart));
    const styledRight = this.theme.fg(isConfirming ? "error" : "dim", rightPart);
    let line = leftPart + " ".repeat(spacing) + styledRight;
    if (isSelected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width, "");
  }

  private renderEmpty(width: number): string {
    let msg: string;
    const items = this.items[this.scope];
    if (this.loading[this.scope]) {
      msg = "  加载中…";
    } else if (!items || items.length === 0) {
      msg =
        this.scope === "current"
          ? "  当前目录无 garden 产物。先跑 /gardener-output all 回填；或 Tab 查看全部。"
          : "  无 garden 产物。先跑 /gardener-output all 回填。";
    } else {
      msg = "  无匹配结果";
    }
    return this.theme.fg("muted", truncateToWidth(msg, width, "…"));
  }

  private renderRename(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.bold("Rename Session"));
    lines.push("");
    lines.push(this.renameInput.render(width, "❯ ", this.focused));
    lines.push("");
    lines.push(this.theme.fg("muted", truncateToWidth("Enter 保存 · Esc 取消", width, "…")));
    return lines;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.border(width));
    lines.push(...this.renderHeader(width));
    if (this.mode === "rename") {
      lines.push(...this.renderRename(width));
      lines.push(this.border(width));
      return lines;
    }
    lines.push(this.searchInput.render(width, this.theme.fg("accent", "❯ "), this.focused));
    lines.push("");
    if (this.flat.length === 0) {
      lines.push(this.renderEmpty(width));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.flat.length - this.maxVisible),
      );
      const endIndex = Math.min(startIndex + this.maxVisible, this.flat.length);
      for (let i = startIndex; i < endIndex; i++) {
        lines.push(this.renderRow(width, this.flat[i], i === this.selectedIndex));
      }
      if (startIndex > 0 || endIndex < this.flat.length) {
        lines.push(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.flat.length})`));
      }
    }
    lines.push(this.renderHint(width));
    lines.push(this.border(width));
    return lines;
  }
}
