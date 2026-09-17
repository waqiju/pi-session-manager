/**
 * index.md 反向同步：把人工编辑过的目录索引应用回 sessions。
 *
 * 背景：pi 内无法把子会话挪到另一个父会话下，也无法批量删除/归档。人工编辑
 * garden/<sub>/index.md（调整缩进 = 换父；行尾加 `to-delete` / `to-archive` 标记）
 * 后，由 /garden 选择器的 Ctrl+G 应用回源数据。入口接线在 extensions/garden.ts，
 * 本文件是纯逻辑 + fs 操作（零运行时 pi 依赖，node --test 直测）。
 *
 * 行格式（生成方 src/index-page.ts；链接与元数据 chip 之间是两个 figure space \u2007）：
 *   - 🗂️ [name](<./<mdBase>.lN.md>)  `580 msgs · 09-14`[ to-delete|to-archive]
 * 解析只认 href（身份）与缩进（层级）；label 允许人改但不生效。行尾标记必须小写、
 * 在元数据反引号块之后；任何对不上的行不参与解析 → 对账阶段数量不符中止。
 *
 * 安全前提（已核实 pi 实现）：
 *   - pi 追加写 jsonl 是 appendFileSync（每次重新打开，无缓存偏移），重写首行
 *     header 不破坏运行中 session 的后续追加；
 *   - pi 解析 header 只校验 type==="session" 与 id 存在，容忍额外字段
 *     （归档写入的 archivedTreePath/archivedAt 不影响 pi 加载）；
 *   - pi 的 session 发现与 collectJobs 都只扫 sessions/<sub>/ 一层，
 *     归档目标 1_archived/ 子目录天然不被转换/列举。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nodeLabel } from "./format.ts";
import type { SessionListItem } from "./session-list.ts";

/** 归档子目录名（在 jsonl 所在目录下新建） */
export const ARCHIVE_DIR_NAME = "1_archived";

/** 行尾标记（必须小写） */
export type IndexMarker = "to-delete" | "to-archive";

export interface IndexRow {
  /** 缩进层级（每级两个空格） */
  depth: number;
  /** 链接目标推出的 mdBase（<日期>-<序号>-<slug>，不含 .lN.md） */
  mdBase: string;
  marker: IndexMarker | null;
  /** 1-based 行号（报错定位用） */
  line: number;
}

/**
 * 解析 index.md 的会话条目行。非条目行（标题/注释/空行）与格式被破坏的行都跳过——
 * 后者会在对账阶段以"数量不一致"中止，宁可拒动也不错改。
 * 链接与反引号之间是 figure space（\u2007，\s 覆盖）；标记前后空格可选。
 */
const ROW_RE = /^(\s*)- \S+ \[.*\]\(<([^<>]+)>\)\s*`[^`\n]*`[ \t]*(to-delete|to-archive)?[ \t]*$/;
const HREF_BASE_RE = /^(.*)\.l\d+\.md$/;

export function parseIndexRows(text: string): IndexRow[] {
  const rows: IndexRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = ROW_RE.exec(lines[i]);
    if (!m) continue;
    const href = m[2].replace(/^\.\//, "");
    const baseMatch = HREF_BASE_RE.exec(href);
    if (!baseMatch) continue;
    rows.push({
      depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2),
      mdBase: baseMatch[1],
      marker: (m[3] as IndexMarker | undefined) ?? null,
      line: i + 1,
    });
  }
  return rows;
}

// ---------- 计划 ----------

export interface ReparentOp {
  item: SessionListItem;
  /** 新父 jsonl 路径；null = 提升为根 */
  newParentPath: string | null;
}

export interface ArchiveOp {
  item: SessionListItem;
  /** 归档前在树中的名称路径（"根 / … / 自身"），写入 header 的 archivedTreePath */
  treePath: string;
}

export interface ReverseSyncPlan {
  reparents: ReparentOp[];
  deletes: SessionListItem[];
  archives: ArchiveOp[];
  /**
   * 父被删除/归档而脱钩为根的未标记节点数（这些节点会被显式置为根，
   * 计数仅用于确认条提示；其 reparent 操作已含在 reparents 里）
   */
  detached: number;
}

export type ReverseSyncPlanResult = { ok: true; plan: ReverseSyncPlan } | { ok: false; error: string };

/** 选择器确认条用的汇总 */
export interface ReverseSyncPreview {
  reparents: number;
  deletes: number;
  archives: number;
  detached: number;
}

export function planPreview(plan: ReverseSyncPlan): ReverseSyncPreview {
  return {
    reparents: plan.reparents.length,
    deletes: plan.deletes.length,
    archives: plan.archives.length,
    detached: plan.detached,
  };
}

function labelOf(item: SessionListItem | undefined, mdBase: string): string {
  return item ? (item.name ?? nodeLabel(item)) : mdBase;
}

/**
 * 对账 + 生成执行计划。任何不一致都中止（返回 ok:false），不动任何文件：
 *   - 行解析为 0 / href 无法匹配会话 / 会话重复出现 / 有会话未出现在 index.md
 *     → "请先 /gardener-output index 重新生成再编辑"
 *   - 缩进跳跃（某行的上一级缺失）→ malformed
 *   - 受保护路径（当前活跃 session）被标记删除/归档 → 拒绝
 * 层级语义：未标记节点的直接父行若被标记删除/归档 → 该节点置为根（计入 detached）；
 * 其余未标记节点父有变化才产生 reparent 写操作。
 */
export function planReverseSync(
  rows: IndexRow[],
  items: SessionListItem[],
  opts: { protectedPaths?: ReadonlySet<string> } = {},
): ReverseSyncPlanResult {
  if (rows.length === 0) {
    return { ok: false, error: "index.md 未解析到任何会话条目；请先 /gardener-output index 重新生成再编辑" };
  }
  const byBase = new Map<string, SessionListItem>();
  for (const item of items) byBase.set(item.mdBase, item);

  // 对账 1：每行 href 必须能匹配到会话
  const unknown = rows.filter((r) => !byBase.has(r.mdBase));
  if (unknown.length) {
    return { ok: false, error: `index.md 第 ${unknown[0].line} 行的链接无法匹配任何会话（${unknown[0].mdBase}）；请先重新生成 index.md 再编辑` };
  }
  // 对账 2：会话不允许重复出现
  const seen = new Set<string>();
  for (const r of rows) {
    const id = byBase.get(r.mdBase)!.id;
    if (seen.has(id)) return { ok: false, error: `index.md 第 ${r.line} 行会话重复出现（${labelOf(byBase.get(r.mdBase), r.mdBase)}）；请先重新生成 index.md 再编辑` };
    seen.add(id);
  }
  // 对账 3：sessions 里的每条都必须出现在 index.md（数量 + id 一一对应）
  const missing = items.filter((it) => !seen.has(it.id));
  if (missing.length) {
    const names = missing.slice(0, 3).map((it) => labelOf(it, it.mdBase)).join("、");
    return {
      ok: false,
      error: `index.md 与 sessions 不一致：缺少 ${missing.length} 条（${names}${missing.length > 3 ? " 等" : ""}）；请先 /gardener-output index 重新生成再编辑`,
    };
  }

  // 深度栈算父行；同一深度的旧行被新行顶替， deeper 截断
  const parentOf = new Map<IndexRow, IndexRow | null>();
  const stack: IndexRow[] = [];
  for (const row of rows) {
    if (row.depth > stack.length) {
      return { ok: false, error: `index.md 第 ${row.line} 行缩进跳跃（深度 ${row.depth + 1} 层但没有上一级）` };
    }
    stack.length = row.depth;
    parentOf.set(row, stack[row.depth - 1] ?? null);
    stack[row.depth] = row;
  }

  const protectedPaths = opts.protectedPaths ?? new Set<string>();
  const plan: ReverseSyncPlan = { reparents: [], deletes: [], archives: [], detached: 0 };
  for (const row of rows) {
    const item = byBase.get(row.mdBase)!;
    if (row.marker === "to-delete") {
      if (protectedPaths.has(item.path)) return { ok: false, error: `不能删除当前活跃 session（${labelOf(item, row.mdBase)}）；请先切换到别的会话` };
      plan.deletes.push(item);
      continue;
    }
    if (row.marker === "to-archive") {
      if (protectedPaths.has(item.path)) return { ok: false, error: `不能归档当前活跃 session（${labelOf(item, row.mdBase)}）；请先切换到别的会话` };
      // 名称路径：沿深度栈取根到自身的 label 拼接
      const chain: string[] = [];
      let cur: IndexRow | null = row;
      while (cur) {
        chain.unshift(labelOf(byBase.get(cur.mdBase), cur.mdBase));
        cur = parentOf.get(cur) ?? null;
      }
      plan.archives.push({ item, treePath: chain.join(" / ") });
      continue;
    }
    const parentRow = parentOf.get(row) ?? null;
    if (parentRow?.marker) {
      // 父行被删除/归档 → 本节点脱钩为根（显式置 null，比留悬空引用干净）
      plan.detached++;
      if (item.parentSessionPath) plan.reparents.push({ item, newParentPath: null });
      continue;
    }
    const newParentPath = parentRow ? byBase.get(parentRow.mdBase)!.path : null;
    if ((item.parentSessionPath ?? null) !== newParentPath) {
      plan.reparents.push({ item, newParentPath });
    }
  }
  return { ok: true, plan };
}

// ---------- 执行（fs） ----------

export interface FsOpResult {
  ok: boolean;
  error?: string;
}

/** 读出并校验首行 header，改写后整文件写回（临时文件 + rename，防半截写入） */
function rewriteHeader(
  jsonlPath: string,
  expectedId: string,
  mutate: (header: Record<string, unknown>) => void,
): FsOpResult {
  let text: string;
  try {
    text = readFileSync(jsonlPath, "utf-8");
  } catch (e) {
    return { ok: false, error: `读取失败: ${(e as Error).message}` };
  }
  const nl = text.indexOf("\n");
  const headerLine = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, "");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerLine);
  } catch {
    return { ok: false, error: "header 行 JSON 解析失败" };
  }
  if (header.type !== "session" || header.id !== expectedId) {
    return { ok: false, error: "header 与预期会话不符（id 不一致），已跳过" };
  }
  mutate(header);
  const out = `${JSON.stringify(header)}${nl < 0 ? "\n" : text.slice(nl)}`;
  const tmp = `${jsonlPath}.tmp-reverse-sync`;
  try {
    writeFileSync(tmp, out);
    renameSync(tmp, jsonlPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, error: `写入失败: ${(e as Error).message}` };
  }
  return { ok: true };
}

/** 换父：改写 jsonl 首行 header 的 parentSession（null = 删除字段，提升为根） */
export function rewriteSessionParent(jsonlPath: string, expectedId: string, newParentPath: string | null): FsOpResult {
  return rewriteHeader(jsonlPath, expectedId, (header) => {
    if (newParentPath === null) delete header.parentSession;
    else header.parentSession = newParentPath;
  });
}

export interface ArchiveResult extends FsOpResult {
  /** 归档后的新路径（成功时必有） */
  archivedPath?: string;
}

/**
 * 归档：header 追加 archivedTreePath / archivedAt（pi 容忍额外字段，不影响加载），
 * 然后挪到 jsonl 所在目录的 1_archived/ 子目录（不存在则新建）。
 * garden md 产物由调用方删除。
 */
export function archiveSessionFile(jsonlPath: string, expectedId: string, treePath: string, now: Date = new Date()): ArchiveResult {
  const dir = path.dirname(jsonlPath);
  const archiveDir = path.join(dir, ARCHIVE_DIR_NAME);
  const dest = path.join(archiveDir, path.basename(jsonlPath));
  if (existsSync(dest)) return { ok: false, error: `归档目标已存在: ${dest}` };
  const r = rewriteHeader(jsonlPath, expectedId, (header) => {
    header.archivedTreePath = treePath;
    header.archivedAt = now.toISOString();
  });
  if (!r.ok) return r;
  try {
    mkdirSync(archiveDir, { recursive: true });
    renameSync(jsonlPath, dest);
  } catch (e) {
    return { ok: false, error: `移动失败: ${(e as Error).message}` };
  }
  return { ok: true, archivedPath: dest };
}
