/**
 * /garden 选择器的 fork 树与搜索（纯逻辑，零依赖，node --test 直测）。
 *
 * 与 pi 内建 SessionSelectorComponent 的关键差异：
 *   pi 的 buildSessionTree 对每个 session 调 3 次 canonicalizePath（= realpathSync），
 *   在 drvfs（WSL symlink → /mnt）上 ~23ms/次：315 session ≈ 22s，且搜索清空 /
 *   切 scope / 删除重命名后全量重付。这里改为**按文件名（basename）字符串匹配**：
 *   jsonl 文件名含 uuid 全局唯一；garden loader 重建的 path 与 frontmatter
 *   parent_session 都派生自它，跨路径风格（symlink / Windows 反斜杠遗留）都能配对。
 *   全程零 syscall。
 */

import type { SessionListItem } from "./session-list.ts";

/** 跨路径风格 basename：同时切 / 和 \（旧 Windows session 的 parentSession 是反斜杠路径） */
export function basenameAny(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export interface TreeNode {
  session: SessionListItem;
  children: TreeNode[];
  /** 子树内最大 modified（排序键：最近活跃的线程排前面） */
  latestActivity: number;
}

export interface FlatNode {
  session: SessionListItem;
  depth: number;
  isLast: boolean;
  /** 各祖先层是否还有后续兄弟（决定画 │ 还是空格） */
  ancestorContinues: boolean[];
}

/**
 * 按 parentSessionPath 把 session 组装成树（roots 与子节点均按 latestActivity 降序）。
 * 配对键 = basename(jsonl 路径)；父不在列表（已删/未转换）→ 降为 root。
 * 损坏数据成环时：环节点不丢（提升为 root），递归带 visited 防爆栈。
 */
export function buildSessionTree(items: SessionListItem[]): TreeNode[] {
  const byName = new Map<string, TreeNode>();
  for (const s of items) {
    byName.set(basenameAny(s.path), { session: s, children: [], latestActivity: s.modified.getTime() });
  }
  const roots: TreeNode[] = [];
  for (const node of byName.values()) {
    const parentKey = node.session.parentSessionPath ? basenameAny(node.session.parentSessionPath) : undefined;
    const parent = parentKey ? byName.get(parentKey) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // 环兜底：从 roots 可达性出发，不可达节点（成环的损坏数据）提升为 root，保证不丢
  const reachable = new Set<TreeNode>();
  const mark = (n: TreeNode): void => {
    if (reachable.has(n)) return;
    reachable.add(n);
    for (const c of n.children) mark(c);
  };
  for (const r of roots) mark(r);
  for (const node of byName.values()) {
    if (!reachable.has(node)) roots.push(node);
  }
  const updateLatest = (node: TreeNode, seen: Set<TreeNode>): number => {
    if (seen.has(node)) return node.latestActivity;
    seen.add(node);
    let latest = node.session.modified.getTime();
    for (const c of node.children) latest = Math.max(latest, updateLatest(c, seen));
    node.latestActivity = latest;
    return latest;
  };
  for (const r of roots) updateLatest(r, new Set());
  const sortNodes = (nodes: TreeNode[], seen: Set<TreeNode>): void => {
    nodes.sort((a, b) => b.latestActivity - a.latestActivity);
    for (const n of nodes) {
      if (seen.has(n)) continue; // 环防御
      seen.add(n);
      sortNodes(n.children, seen);
    }
  };
  sortNodes(roots, new Set());
  return roots;
}

/** 树 → 带缩进元数据的平铺显示列表（前序遍历；环防御：已访问节点跳过） */
export function flattenSessionTree(roots: TreeNode[]): FlatNode[] {
  const result: FlatNode[] = [];
  const seen = new Set<TreeNode>();
  const walk = (node: TreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
    if (seen.has(node)) return;
    seen.add(node);
    result.push({ session: node.session, depth, isLast, ancestorContinues });
    for (let i = 0; i < node.children.length; i++) {
      const childIsLast = i === node.children.length - 1;
      // 只有非根祖先需要延续线（与 pi 渲染一致）
      const continues = depth > 0 ? !isLast : false;
      walk(node.children[i], depth + 1, [...ancestorContinues, continues], childIsLast);
    }
  };
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i], 0, [], i === roots.length - 1);
  }
  return result;
}

// ---------- 搜索（语法对齐内建：fuzzy token / "phrase" 精确 / re: 正则） ----------

export interface QueryToken {
  kind: "fuzzy" | "phrase";
  value: string;
}

export type ParsedQuery =
  | { mode: "tokens"; tokens: QueryToken[] }
  | { mode: "regex"; regex: RegExp | null; error?: string };

/**
 * 解析搜索框输入：
 *   re:<pattern>   → 正则（大小写不敏感）；空/坏正则 → regex:null（匹配一切为零）
 *   "a b"          → 精确短语（空白归一化后 indexOf）；引号不配对 → 退回普通分词
 *   其余空白分词    → fuzzy（字符按序出现即命中）
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  if (!trimmed) return { mode: "tokens", tokens: [] };
  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) return { mode: "regex", regex: null, error: "Empty regex" };
    try {
      return { mode: "regex", regex: new RegExp(pattern, "i") };
    } catch (err) {
      return { mode: "regex", regex: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const tokens: QueryToken[] = [];
  let buf = "";
  let inQuote = false;
  let hadUnclosedQuote = false;
  const flush = (kind: "fuzzy" | "phrase"): void => {
    const v = buf.trim();
    buf = "";
    if (v) tokens.push({ kind, value: v });
  };
  for (const ch of trimmed) {
    if (ch === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      flush("fuzzy");
      continue;
    }
    buf += ch;
  }
  if (inQuote) hadUnclosedQuote = true;
  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => ({ kind: "fuzzy" as const, value: t })),
    };
  }
  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens };
}

/** 子序列模糊匹配（大小写不敏感）。分数越低越好：命中起点 + 命中跨度超出查询的部分。 */
export function fuzzyMatch(query: string, text: string): { matches: boolean; score: number } {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { matches: true, score: 0 };
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first < 0) first = ti;
      last = ti;
      qi++;
    }
  }
  if (qi < q.length) return { matches: false, score: 0 };
  return { matches: true, score: first + (last - first + 1 - q.length) };
}

const normalizeWs = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** 搜索语料（与内建同：id + name + 全文 + cwd）。WeakMap 缓存避免每个按键重复拼接。 */
const searchTextCache = new WeakMap<SessionListItem, { raw: string; norm: string }>();
function searchText(item: SessionListItem): { raw: string; norm: string } {
  let hit = searchTextCache.get(item);
  if (!hit) {
    const raw = `${item.id} ${item.name ?? ""} ${item.allMessagesText} ${item.cwd}`;
    hit = { raw, norm: normalizeWs(raw) };
    searchTextCache.set(item, hit);
  }
  return hit;
}

export function matchSession(item: SessionListItem, parsed: ParsedQuery): { matches: boolean; score: number } {
  const text = searchText(item);
  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const idx = text.raw.search(parsed.regex);
    return idx < 0 ? { matches: false, score: 0 } : { matches: true, score: idx * 0.1 };
  }
  if (parsed.tokens.length === 0) return { matches: true, score: 0 };
  let total = 0;
  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      const phrase = normalizeWs(token.value);
      if (!phrase) continue;
      const idx = text.norm.indexOf(phrase);
      if (idx < 0) return { matches: false, score: 0 };
      total += idx * 0.1;
      continue;
    }
    const m = fuzzyMatch(token.value, text.raw);
    if (!m.matches) return { matches: false, score: 0 };
    total += m.score;
  }
  return { matches: true, score: total };
}

/** 过滤 + 排序（score 升序，同分按最近活跃）。query 为空 → 原样返回（调用方走树模式）。 */
export function filterAndSortSessions(items: SessionListItem[], query: string): SessionListItem[] {
  const parsed = parseSearchQuery(query);
  if (parsed.mode === "tokens" && parsed.tokens.length === 0) return items;
  const scored: { item: SessionListItem; score: number }[] = [];
  for (const item of items) {
    const m = matchSession(item, parsed);
    if (m.matches) scored.push({ item, score: m.score });
  }
  scored.sort((a, b) => a.score - b.score || b.item.modified.getTime() - a.item.modified.getTime());
  return scored.map((s) => s.item);
}
