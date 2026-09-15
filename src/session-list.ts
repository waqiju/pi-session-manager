/**
 * 快速 session 列表：为 `/garden` 选择器供数。
 *
 * 数据源 = garden md 产物（不再读 sessions/*.jsonl；假设 garden 转换常驻、产物最新）：
 *   - 扫描 garden/<sub>/ 下的 *.lN.md，每个 base 取最优级别（l3 > l2 > l1 > l0）
 *   - frontmatter → id / cwd / started / ended / name / messages 计数 / source / parent_session
 *   - 正文 → firstMessage（首个 `## 🙋 User` 小节）与 allMessagesText（全文搜索语料，
 *     `fullText:false` 时只读头部 4KB，退回只搜 id/name/cwd）
 *   - jsonl 路径 = <sessionsRoot>/<sub>/<frontmatter source> 重建（选择器选中时交回 pi
 *     switchSession；文件已删的可能性在选中时再校验，列表期零额外 syscall）
 *   - 无 source 字段的旧版产物跳过（/gardener-output all 回填后即出现）
 *
 * 性能：每 session 一次有界读（l3 平均 ~14KB，上限 1MB 防异常），并发 16；
 * 315 session ≈ 2-3s（drvfs 实测），且全程无 realpathSync。
 */

import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** 选择器消费的 session 列表项（md 是唯一数据源） */
export interface SessionListItem {
  /** 重建的 jsonl 路径（switchSession 用；jsonl 已删时该路径不存在） */
  path: string;
  id: string;
  cwd: string;
  name?: string;
  /** 重建的父 jsonl 路径（fork 树按 basename 匹配，见 session-tree.ts） */
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  /** 全文搜索语料（md 正文，剥 frontmatter；fullText:false 时为空串） */
  allMessagesText: string;
  /** garden 产物目录（选择器删除 session 时同步清理 md） */
  mdDir: string;
  /** garden 产物 base 名（<date>-<seq>-<slug>，不含 .lN.md 后缀） */
  mdBase: string;
}

/** garden 正文读取上限（全文搜索语料；l3 平均 ~14KB，上限只是防异常大文件） */
export const FULLTEXT_READ_BYTES = 1024 * 1024;
/** 只取 frontmatter 时的读取上限（frontmatter 仅 ~20 行；顺带可能捕到首个 User 小节） */
export const FRONTMATTER_READ_BYTES = 4096;
/** firstMessage 长度上限（选择器只显示一行，语料搜索用 allMessagesText） */
const FIRST_MESSAGE_MAX_CHARS = 300;

export interface GardenFrontmatter {
  sessionId?: string;
  name?: string;
  messageCount?: number;
  cwd?: string;
  started?: string;
  ended?: string;
  /** jsonl 文件名（basename），重建 jsonl 路径用 */
  source?: string;
  /** jsonl header.parentSession 原样记录（全路径，可能是 Windows 反斜杠风格） */
  parentSession?: string;
}

/** JSON 字符串标量（frontmatter 的值都是 JSON.stringify 过的） */
function parseQuoted(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const s = JSON.parse(v);
    return typeof s === "string" && s ? s : undefined;
  } catch {
    return undefined;
  }
}

/** 解析 garden md frontmatter（容忍缺字段/坏格式） */
export function parseGardenFrontmatter(text: string): GardenFrontmatter {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const body = m[1];
  const out: GardenFrontmatter = {};
  const field = (name: string): string | undefined => parseQuoted(new RegExp(`^${name}: (".*")$`, "m").exec(body)?.[1]);
  const assign = (key: keyof GardenFrontmatter, v: string | undefined): void => {
    if (v !== undefined) out[key] = v;
  };
  assign("sessionId", field("session_id"));
  assign("name", field("name"));
  assign("cwd", field("cwd"));
  assign("started", field("started"));
  assign("ended", field("ended"));
  assign("source", field("source"));
  assign("parentSession", field("parent_session"));
  const msgMatch = /^messages:\n((?:  \w+: \d+\n?)+)/m.exec(body);
  if (msgMatch) {
    let sum = 0;
    for (const line of msgMatch[1].split("\n")) {
      const kv = /^  \w+: (\d+)$/.exec(line);
      if (kv) sum += Number(kv[1]);
    }
    if (sum > 0) out.messageCount = sum;
  }
  return out;
}

/** 剥掉 md 开头的 yaml frontmatter（无 frontmatter 原样返回） */
export function stripFrontmatter(text: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** 首个 `## 🙋 User` 小节的正文（l0-l3 渲染共用该标题前缀）；无 → undefined */
export function extractFirstUserMessage(body: string): string | undefined {
  const m = /## 🙋 User · [^\n]*\n+/.exec(body);
  if (!m) return undefined;
  const rest = body.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  let text = (end >= 0 ? rest.slice(0, end) : rest).trim();
  if (!text) return undefined;
  if (text.length > FIRST_MESSAGE_MAX_CHARS) text = text.slice(0, FIRST_MESSAGE_MAX_CHARS);
  return text;
}

/** 目录内一层 *.md（跳过点开头的目录/文件）；目录不存在返回空 */
export async function collectMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** garden 根下所有子目录（含 symlink 目录；跳过点开头的目录，如手工归档的 .mono） */
export async function collectSubdirs(gardenRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(gardenRoot, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => path.join(gardenRoot, e.name))
      .sort();
  } catch {
    return [];
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** 读文件前 maxBytes；文件不存在/不可读返回 null */
async function readBounded(filePath: string, maxBytes: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    if (bytesRead === 0) return "";
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 输出文件名：<base>.lN.md */
const MD_FILE_RE = /^(.*)\.l(\d+)\.md$/;
/** 选择器语料的级别性价比：l3（纯问答对话）与默认导出级别对齐，最优；缺 l3 时退化 l2 > l1 > l0 */
const LEVEL_PICK: Record<string, number> = { l3: 4, l2: 3, l1: 2, l0: 1 };

interface MdCandidate {
  base: string;
  file: string;
  level: string;
}

/** 同 base 多级别取最优（l3 > l2 > l1 > l0；未知级别最低） */
function pickBestPerBase(files: string[]): MdCandidate[] {
  const byBase = new Map<string, MdCandidate>();
  for (const f of files) {
    const m = MD_FILE_RE.exec(f);
    if (!m) continue;
    const cand: MdCandidate = { base: m[1], file: f, level: `l${m[2]}` };
    const existing = byBase.get(cand.base);
    if (!existing || (LEVEL_PICK[cand.level] ?? 0) > (LEVEL_PICK[existing.level] ?? 0)) {
      byBase.set(cand.base, cand);
    }
  }
  return [...byBase.values()];
}

/** 新命名风格：<date>-<seq>-<slug>（区别于旧风格 <ISO时间戳>_<id>） */
const NEW_NAME_RE = /^\d{4}-\d{2}-\d{2}-\d{3}-/;

export interface FastListOptions {
  onProgress?: (loaded: number, total: number) => void;
  concurrency?: number;
  /** 是否读 md 正文作全文搜索语料（默认 true；false = 只读头部 4KB，退回只搜 id/name/cwd） */
  fullText?: boolean;
}

function toDate(value: string | undefined, fallbackMs: number): Date {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? new Date(fallbackMs) : new Date(t);
}

/** current scope：某项目 gardenDir 的快速列表。jsonl 路径按标准布局从 gardenDir 推导 */
export async function listProjectSessions(gardenDir: string, opts: FastListOptions = {}): Promise<SessionListItem[]> {
  const sub = path.basename(gardenDir);
  const gardenRoot = path.dirname(gardenDir);
  const sessionsRoot = path.join(path.dirname(gardenRoot), "sessions");
  const concurrency = opts.concurrency ?? 16;
  const maxBytes = opts.fullText === false ? FRONTMATTER_READ_BYTES : FULLTEXT_READ_BYTES;

  const candidates = pickBestPerBase(await collectMdFiles(gardenDir));
  let loaded = 0;
  const items = await mapLimit(candidates, concurrency, async (cand): Promise<{ item: SessionListItem; mtimeMs: number } | null> => {
    try {
      const filePath = path.join(gardenDir, cand.file);
      const [text, st] = await Promise.all([readBounded(filePath, maxBytes), stat(filePath)]);
      if (!text) return null;
      const fm = parseGardenFrontmatter(text);
      if (!fm.sessionId || !fm.source) return null; // 旧版产物（无 source）跳过：all 回填后出现
      const stripped = stripFrontmatter(text);
      const item: SessionListItem = {
        path: path.join(sessionsRoot, sub, fm.source),
        id: fm.sessionId,
        cwd: fm.cwd ?? "",
        name: fm.name,
        parentSessionPath: fm.parentSession
          ? path.join(sessionsRoot, sub, path.basename(fm.parentSession.replace(/\\/g, "/")))
          : undefined,
        created: toDate(fm.started, st.mtimeMs),
        modified: toDate(fm.ended, st.mtimeMs),
        messageCount: fm.messageCount ?? 0,
        firstMessage: extractFirstUserMessage(stripped) ?? "(no messages)",
        allMessagesText: opts.fullText === false ? "" : stripped,
        mdDir: gardenDir,
        mdBase: cand.base,
      };
      return { item, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    } finally {
      loaded++;
      opts.onProgress?.(loaded, candidates.length);
    }
  });
  // 同 session 多份产物（改名/重编号残留）去重：新命名风格优先，同风格取 mtime 新者
  const byId = new Map<string, { item: SessionListItem; mtimeMs: number }>();
  for (const wrapped of items) {
    if (!wrapped) continue;
    const { item, mtimeMs } = wrapped;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, { item, mtimeMs });
      continue;
    }
    const itemNew = NEW_NAME_RE.test(item.mdBase);
    const existNew = NEW_NAME_RE.test(existing.item.mdBase);
    if ((itemNew && !existNew) || (itemNew === existNew && mtimeMs > existing.mtimeMs)) {
      byId.set(item.id, { item, mtimeMs });
    }
  }
  return [...byId.values()].map((v) => v.item);
}

/** all scope：garden 根下全部子目录的快速列表（一层，跳过隐藏目录）；子目录间并发 */
export async function listAllSessions(gardenRoot: string, opts: FastListOptions = {}): Promise<SessionListItem[]> {
  const subdirs = await collectSubdirs(gardenRoot);
  const concurrency = opts.concurrency ?? 16;
  // 先各子目录列文件名拿 total（进度条分母）；正式读取在 listProjectSessions 内复算（readdir 廉价，换实现复用）
  const filesPerDir = await mapLimit(subdirs, concurrency, async (d) => pickBestPerBase(await collectMdFiles(d)));
  let total = 0;
  for (const files of filesPerDir) total += files.length;
  let loaded = 0;
  const perDir = await mapLimit(subdirs, Math.min(8, concurrency), async (sub) => {
    return listProjectSessions(sub, {
      ...opts,
      onProgress: () => {
        loaded++;
        opts.onProgress?.(loaded, total);
      },
    });
  });
  return perDir.flat();
}

/** 推导 sessionDir 对应的 garden 输出目录：<agentRoot>/sessions/<sub> → <agentRoot>/garden/<sub> */
export function gardenDirForSessionDir(sessionDir: string): string {
  return path.join(path.dirname(path.dirname(sessionDir)), "garden", path.basename(sessionDir));
}

/** 推导 sessionDir 对应的 garden 根目录：<agentRoot>/sessions/<sub> → <agentRoot>/garden */
export function gardenRootForSessionDir(sessionDir: string): string {
  return path.dirname(gardenDirForSessionDir(sessionDir));
}
