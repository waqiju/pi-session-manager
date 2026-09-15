/**
 * 快速 session 列表：为 `/garden` 选择器供数。
 *
 * pi 内建 /resume 的 buildSessionInfo 逐行读完整个 jsonl（messageCount / name /
 * firstMessage / allMessagesText），在慢盘（如 drvfs）上数百个 session 非常慢。
 * 这里每个文件只做**一次有界读**（首 64KB）：
 *   - 第 1 行 → header（id / cwd / timestamp / parentSession —— fork 继承链全靠它）
 *   - 缓冲内顺带找：首条 user 消息文本（firstMessage）、session_info 名（name）
 *   - modified 用 stat.mtime 近似（选择器只用它排序）
 * 再按需从 garden md 富化（garden 转换常驻，几乎免费）：
 *   - 输出文件名是可读命名（<date>-<seq>-<slug>.lN.md），与源 jsonl 名无推导关系，
 *     按 frontmatter session_id 建 l2 索引反查（buildGardenIndex）
 *   - l2 frontmatter → name / messageCount
 *   - l2 正文 → allMessagesText（选择器全文搜索语料；语义与内建的 user+assistant text
 *     相当。全量仅数 MB 级，远小于 jsonl 全读，默认可直接开；
 *     PI_GARDEN_SELECTOR_FULLTEXT=0 可关，退回 A2 取舍：只搜 id/name/cwd）
 */

import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** pi SessionSelectorComponent 期望的 SessionInfo 形状（鸭子类型对齐） */
export interface SessionListItem {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

/** 单文件头部读取上限（一次 read 调用） */
export const HEAD_READ_BYTES = 64 * 1024;
/** garden frontmatter 读取上限（frontmatter 仅 ~20 行） */
const FRONTMATTER_READ_BYTES = 4096;
/** garden 正文读取上限（全文搜索语料；l2 平均 ~20KB，上限只是防异常大文件） */
export const FULLTEXT_READ_BYTES = 1024 * 1024;
/** 头部信息：header + 缓冲内能找到的 firstMessage / name */
export interface SessionHead {
  id: string;
  cwd: string;
  timestamp: string;
  parentSessionPath?: string;
  firstMessage?: string;
  name?: string;
}

/** 从 message content 提取纯文本（string 或 content 数组两种形态） */
function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((c) => c && typeof c === "object" && (c as any).type === "text")
    .map((c) => (c as any).text as string)
    .join("\n")
    .trim();
  return text || undefined;
}

/** 读 session 文件头部；非 session 文件（首行无 header）返回 null */
export async function readSessionHead(filePath: string): Promise<SessionHead | null> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_READ_BYTES, 0);
    if (bytesRead === 0) return null;
    let text = buf.toString("utf8", 0, bytesRead);
    // 缓冲截断的末行可能不完整：文件比缓冲大且末尾无换行 → 丢弃末行
    if (bytesRead === HEAD_READ_BYTES && !text.endsWith("\n")) {
      text = text.slice(0, text.lastIndexOf("\n") + 1);
    }
    let header: SessionHead | null = null;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let obj: any;
      try {
        obj = JSON.parse(t);
      } catch {
        continue; // 残缺行
      }
      if (!header) {
        if (obj?.type !== "session") return null;
        header = {
          id: typeof obj.id === "string" ? obj.id : "",
          cwd: typeof obj.cwd === "string" ? obj.cwd : "",
          timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
          parentSessionPath: typeof obj.parentSession === "string" ? obj.parentSession : undefined,
        };
        continue;
      }
      if (obj?.type === "session_info") {
        const n = typeof obj.name === "string" ? obj.name.trim() : "";
        header.name = n || undefined; // 取缓冲内最后一个（含显式清除）
        continue;
      }
      if (!header.firstMessage && obj?.type === "message" && obj.message?.role === "user") {
        header.firstMessage = extractText(obj.message.content);
      }
    }
    return header;
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 目录内一层 *.jsonl（跳过点开头的目录/文件）；目录不存在返回空 */
export async function collectSessionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl") && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** sessions 根下所有子目录（含 symlink 目录，对齐内建 listAll；跳过点开头的目录，如手工归档的 .mono） */
export async function collectSessionSubdirs(sessionsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => path.join(sessionsRoot, e.name))
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

/** 解析 garden md frontmatter 的 name 与 messages 计数（容忍缺字段/坏格式） */
export function parseGardenFrontmatter(text: string): { name?: string; messageCount?: number } {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const body = m[1];
  const out: { name?: string; messageCount?: number } = {};
  const nameMatch = /^name: (".*")$/m.exec(body);
  if (nameMatch) {
    try {
      const n = JSON.parse(nameMatch[1]);
      if (typeof n === "string" && n.trim()) out.name = n;
    } catch {
      /* 忽略坏 name */
    }
  }
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

/** 剥掉 md 开头的 yaml frontmatter（无 frontmatter 原样返回） */
export function stripFrontmatter(text: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

export interface EnrichOptions {
  /** 是否读 l2 正文回填 allMessagesText（默认 true；false = 只取 frontmatter） */
  fullText?: boolean;
}

/** 新命名风格：<date>-<seq>-<slug>.lN.md（区别于旧风格 <ISO时间戳>_<id>.lN.md） */
const NEW_NAME_RE = /^\d{4}-\d{2}-\d{2}-\d{3}-/;

/** garden 索引：session_id → 该 session l2 md 的 { 文件名, 有界内容 }（fullText 开到 1MB，否则只读头部） */
export type GardenIndex = Map<string, { name: string; text: string }>;

/**
 * 建 garden 输出目录的 l2 索引：session_id → l2 文件内容（有界）。
 * 输出文件名是可读命名（<date>-<seq>-<slug>），与源 jsonl 文件名无推导关系，
 * 只能靠 frontmatter 的 session_id 反查（与 cli.ts indexOutputsBySessionId 同思路，
 * 但只索引 l2：name/messageCount/全文语料都从它来；缺 l2 的 session 放弃富化）。
 * 同 session 多份 l2（改名/重编号残留）时新命名风格优先。
 * 索引直接持内容而非路径：富化不再二次打开，每 session 全程仅一次 l2 读。
 */
export async function buildGardenIndex(gardenDir: string, opts?: EnrichOptions): Promise<GardenIndex> {
  const index: GardenIndex = new Map();
  const maxBytes = opts?.fullText !== false ? FULLTEXT_READ_BYTES : FRONTMATTER_READ_BYTES;
  let entries;
  try {
    entries = await readdir(gardenDir, { withFileTypes: true });
  } catch {
    return index;
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".l2.md")).map((e) => e.name).sort();
  const found = await mapLimit(files, 16, async (name) => {
    const text = await readBounded(path.join(gardenDir, name), maxBytes);
    if (!text) return null;
    const m = /^session_id: ("(?:[^"\\]|\\.)*")$/m.exec(text);
    if (!m) return null;
    try {
      const id = JSON.parse(m[1]);
      return typeof id === "string" && id ? { name, id, text } : null;
    } catch {
      return null; // 坏 session_id 跳过
    }
  });
  // 顺序解决冲突（并发读完成后单线程应用）：同 session 多份 l2 时新命名风格优先
  for (const f of found) {
    if (!f) continue;
    const existing = index.get(f.id);
    if (!existing || (NEW_NAME_RE.test(f.name) && !NEW_NAME_RE.test(existing.name))) {
      index.set(f.id, { name: f.name, text: f.text });
    }
  }
  return index;
}

/**
 * 用 garden 索引富化单个 item（只补缺失字段；无 I/O，索引已持内容）。
 * fullText 开（默认建索引时读正文）：frontmatter（name/messageCount）+ 正文
 * （allMessagesText，选择器全文搜索语料）；关：只有 frontmatter。
 */
export function enrichFromGarden(item: SessionListItem, gardenIndex: GardenIndex, opts?: EnrichOptions): void {
  const needText = opts?.fullText !== false && !item.allMessagesText;
  if (item.name && item.messageCount > 0 && !needText) return;
  const hit = gardenIndex.get(item.id);
  if (!hit) return;
  const fm = parseGardenFrontmatter(hit.text);
  if (!item.name && fm.name) item.name = fm.name;
  if (item.messageCount === 0 && fm.messageCount) item.messageCount = fm.messageCount;
  if (needText) item.allMessagesText = stripFrontmatter(hit.text);
}

export interface FastListOptions {
  onProgress?: (loaded: number, total: number) => void;
  concurrency?: number;
  /** 富化用的 garden 输出目录（该 scope 对应 sub 目录）；不传则跳过富化 */
  gardenDir?: string;
  /** 是否读 garden l2/l3 正文作全文搜索语料（默认 true；false 退回只搜 id/name/cwd） */
  fullText?: boolean;
}

async function headsToItems(files: string[], gardenDir: string | undefined, opts: FastListOptions): Promise<SessionListItem[]> {
  const concurrency = opts.concurrency ?? 16;
  const gardenIndex = gardenDir && files.length > 0 ? await buildGardenIndex(gardenDir, { fullText: opts.fullText }) : undefined;
  let loaded = 0;
  const items = await mapLimit(files, concurrency, async (file): Promise<SessionListItem | null> => {
    try {
      const [head, st] = await Promise.all([readSessionHead(file), stat(file)]);
      if (!head) return null;
      const item: SessionListItem = {
        path: file,
        id: head.id,
        cwd: head.cwd,
        name: head.name,
        parentSessionPath: head.parentSessionPath,
        created: new Date(head.timestamp || st.mtimeMs),
        modified: st.mtime,
        messageCount: 0,
        firstMessage: head.firstMessage ?? "",
        allMessagesText: "",
      };
      if (gardenIndex) enrichFromGarden(item, gardenIndex, { fullText: opts.fullText });
      if (!item.firstMessage) item.firstMessage = "(no messages)"; // 对齐内建显示兜底
      return item;
    } catch {
      return null;
    } finally {
      loaded++;
      opts.onProgress?.(loaded, files.length);
    }
  });
  return items.filter((x): x is SessionListItem => x !== null);
}

/** 推导 sessionDir 对应的 garden 输出目录：<agentRoot>/sessions/<sub> → <agentRoot>/garden/<sub> */
export function gardenDirForSessionDir(sessionDir: string): string {
  return path.join(path.dirname(path.dirname(sessionDir)), "garden", path.basename(sessionDir));
}

/** current scope：某项目 sessionDir 的快速列表。gardenDir 缺省按标准布局推导 */
export async function listProjectSessions(sessionDir: string, opts: FastListOptions = {}): Promise<SessionListItem[]> {
  const files = await collectSessionFiles(sessionDir);
  const gardenDir = opts.gardenDir ?? gardenDirForSessionDir(sessionDir);
  return headsToItems(files, gardenDir, opts);
}

/** all scope：sessions 根下全部子目录的快速列表（一层，跳过隐藏目录）；子目录间并发 */
export async function listAllSessions(sessionsRoot: string, opts: FastListOptions = {}): Promise<SessionListItem[]> {
  const subdirs = await collectSessionSubdirs(sessionsRoot);
  const agentRoot = path.dirname(sessionsRoot);
  const concurrency = opts.concurrency ?? 16;
  const filesPerDir = await mapLimit(subdirs, concurrency, async (d) => collectSessionFiles(d));
  let total = 0;
  for (const files of filesPerDir) total += files.length;
  let loaded = 0;
  const perDir = await mapLimit(subdirs, Math.min(8, concurrency), async (sub, i) => {
    const gardenDir = opts.gardenDir === undefined ? path.join(agentRoot, "garden", path.basename(sub)) : opts.gardenDir;
    return headsToItems(filesPerDir[i], gardenDir, {
      ...opts,
      onProgress: () => {
        loaded++;
        opts.onProgress?.(loaded, total);
      },
    });
  });
  return perDir.flat();
}
