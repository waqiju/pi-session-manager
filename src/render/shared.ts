import type { Entry, SessionHeader, Usage } from "../types.ts";

export interface RenderOptions {
  /** 源文件名（xxx.jsonl），写入 frontmatter */
  sourceName?: string;
}

/** L1 截断常量（头 + 尾） */
export const TRUNC_HEAD = 1500;
export const TRUNC_TAIL = 500;
/** toolCall arguments 中超过该长度的字符串值会被头尾截断（L1） */
export const TRUNC_ARG_LIMIT = 2000;

/** ISO 时间戳 → HH:MM:SS（UTC，稳定可读） */
export function fmtTime(iso: string | undefined): string {
  if (!iso || iso.length < 19) return "?";
  return iso.slice(11, 19);
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 自适应代码围栏：内容里最长反引号串 + 1，保证不炸 */
export function fence(text: string, info = ""): string {
  let max = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) max = Math.max(max, m[0].length);
  const f = "`".repeat(Math.max(3, max + 1));
  return `${f}${info}\n${text}\n${f}`;
}

/** 头 head + 尾 tail，中间标注省略字符数 */
export function truncateHeadTail(text: string, head = TRUNC_HEAD, tail = TRUNC_TAIL): string {
  if (text.length <= head + tail + 64) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n... (省略 ${omitted} 字符) ...\n\n${text.slice(text.length - tail)}`;
}

/** 深遍历 JSON：超过 limit 的字符串值做头尾截断（用于 L1 的 toolCall arguments） */
export function truncateLongStrings(value: unknown, limit = TRUNC_ARG_LIMIT): unknown {
  if (typeof value === "string") return value.length > limit ? truncateHeadTail(value) : value;
  if (Array.isArray(value)) return value.map((v) => truncateLongStrings(v, limit));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateLongStrings(v, limit);
    return out;
  }
  return value;
}

/** base64 图片 → 占位符 */
export function imagePlaceholder(mimeType: string, data: string): string {
  const bytes = Math.round((data?.length ?? 0) * 0.75);
  return `*[image: ${mimeType}, ${fmtBytes(bytes)}]*`;
}

/**
 * 分支跳回检测：entry 的 parent 不是上一条 entry（按文件顺序）时，
 * 说明发生了分支/回退，给一行提示。
 */
export function branchNote(prev: Entry | null, entry: Entry): string | null {
  if (!prev) return null;
  if (entry.parentId === prev.id) return null;
  if (entry.parentId == null) return `> ⑂ 回到会话起点`;
  return `> ⑂ 跳回分支点 \`${entry.parentId}\``;
}

// ---------- frontmatter ----------

interface Stats {
  msgCounts: Record<string, number>;
  models: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  name: string | null;
  ended: string | null;
}

function addUsage(stats: Stats, u: Usage | undefined): void {
  if (!u) return;
  stats.tokens.input += u.input ?? 0;
  stats.tokens.output += u.output ?? 0;
  stats.tokens.cacheRead += u.cacheRead ?? 0;
  stats.tokens.cacheWrite += u.cacheWrite ?? 0;
  stats.tokens.total += u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  stats.cost += u.cost?.total ?? 0;
}

export function collectStats(entries: Entry[]): Stats {
  const stats: Stats = {
    msgCounts: {},
    models: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    name: null,
    ended: null,
  };
  for (const e of entries) {
    if (e.timestamp) stats.ended = e.timestamp;
    if (e.type === "message") {
      const msg = (e as any).message;
      const role = msg?.role ?? "unknown";
      stats.msgCounts[role] = (stats.msgCounts[role] ?? 0) + 1;
      if (msg?.usage) addUsage(stats, msg.usage);
      const model = msg?.model;
      if (model && !stats.models.includes(model)) stats.models.push(model);
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      addUsage(stats, (e as any).usage);
    } else if (e.type === "model_change") {
      const m = (e as any).modelId;
      if (m && !stats.models.includes(m)) stats.models.push(m);
    } else if (e.type === "session_info") {
      stats.name = (e as any).name ?? null;
    }
  }
  return stats;
}

/** YAML 字符串引用：JSON 字符串是合法的 YAML 双引号标量 */
const q = (s: string): string => JSON.stringify(s);

export function frontmatter(
  header: SessionHeader | null,
  entries: Entry[],
  level: string,
  sourceName?: string,
): string {
  const stats = collectStats(entries);
  const lines: string[] = ["---"];
  lines.push(`level: ${q(level)}`);
  lines.push(`session_id: ${q(header?.id ?? "unknown")}`);
  if (header?.cwd) lines.push(`cwd: ${q(header.cwd)}`);
  if (header?.timestamp) lines.push(`started: ${q(header.timestamp)}`);
  if (stats.ended) lines.push(`ended: ${q(stats.ended)}`);
  if (stats.name) lines.push(`name: ${q(stats.name)}`);
  if (stats.models.length) {
    lines.push(`models:`);
    for (const m of stats.models) lines.push(`  - ${q(m)}`);
  }
  lines.push(`messages:`);
  for (const [role, n] of Object.entries(stats.msgCounts)) lines.push(`  ${role}: ${n}`);
  lines.push(`tokens:`);
  lines.push(`  input: ${stats.tokens.input}`);
  lines.push(`  output: ${stats.tokens.output}`);
  lines.push(`  cache_read: ${stats.tokens.cacheRead}`);
  lines.push(`  cache_write: ${stats.tokens.cacheWrite}`);
  lines.push(`  total: ${stats.tokens.total}`);
  lines.push(`cost_total: ${Math.round(stats.cost * 10000) / 10000}`);
  if (sourceName) lines.push(`source: ${q(sourceName)}`);
  lines.push(`generator: "garden"`);
  lines.push("---");
  return lines.join("\n");
}
