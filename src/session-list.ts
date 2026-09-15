/**
 * 快速 session 列表：为 `/garden` 选择器供数。
 *
 * pi 内建 /resume 的 buildSessionInfo 逐行读完整个 jsonl（messageCount / name /
 * firstMessage / allMessagesText），在慢盘（如 drvfs）上数百个 session 非常慢。
 * 这里每个文件只做**一次有界读**（首 64KB）：
 *   - 第 1 行 → header（id / cwd / timestamp / parentSession —— fork 继承链全靠它）
 *   - 缓冲内顺带找：首条 user 消息文本（firstMessage）、session_info 名（name）
 *   - modified 用 stat.mtime 近似（选择器只用它排序）
 * 再按需从 garden md frontmatter 富化 name / messageCount（garden 转换常驻，几乎免费）。
 *
 * 已知取舍：不建 allMessagesText，内容全文搜索不可用（id / name / cwd 可搜）。
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

/** sessions 根下所有子目录（跳过点开头的目录，如手工归档的 .mono） */
export async function collectSessionSubdirs(sessionsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
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

/**
 * 从 garden frontmatter 富化单个 item（只补缺失字段）。
 * gardenDir = 该 session 所在 sub 对应的 garden 输出目录；级别间 frontmatter 相同，读最小优先。
 */
export async function enrichFromGarden(item: SessionListItem, gardenDir: string): Promise<void> {
  if (item.name && item.messageCount > 0) return;
  const base = path.basename(item.path).replace(/\.jsonl$/, "");
  for (const level of ["l2", "l0", "l1", "l3"]) {
    let text: string;
    try {
      const fh = await open(path.join(gardenDir, `${base}.${level}.md`), "r");
      try {
        const buf = Buffer.alloc(FRONTMATTER_READ_BYTES);
        const { bytesRead } = await fh.read(buf, 0, FRONTMATTER_READ_BYTES, 0);
        text = buf.toString("utf8", 0, bytesRead);
      } finally {
        await fh.close().catch(() => {});
      }
    } catch {
      continue; // 该级别不存在，试下一个
    }
    const fm = parseGardenFrontmatter(text);
    if (!item.name && fm.name) item.name = fm.name;
    if (item.messageCount === 0 && fm.messageCount) item.messageCount = fm.messageCount;
    return; // 找到一份 frontmatter 就够（各级别相同）
  }
}

export interface FastListOptions {
  onProgress?: (loaded: number, total: number) => void;
  concurrency?: number;
  /** 富化用的 garden 输出目录（该 scope 对应 sub 目录）；不传则跳过富化 */
  gardenDir?: string;
}

async function headsToItems(files: string[], gardenDir: string | undefined, opts: FastListOptions): Promise<SessionListItem[]> {
  const concurrency = opts.concurrency ?? 16;
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
      if (gardenDir) await enrichFromGarden(item, gardenDir);
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

/** all scope：sessions 根下全部子目录的快速列表（一层，跳过隐藏目录） */
export async function listAllSessions(sessionsRoot: string, opts: FastListOptions = {}): Promise<SessionListItem[]> {
  const subdirs = await collectSessionSubdirs(sessionsRoot);
  const agentRoot = path.dirname(sessionsRoot);
  const all: SessionListItem[] = [];
  let total = 0;
  let loaded = 0;
  const filesPerDir = await mapLimit(subdirs, opts.concurrency ?? 16, async (d) => collectSessionFiles(d));
  for (const files of filesPerDir) total += files.length;
  for (let i = 0; i < subdirs.length; i++) {
    const gardenDir = opts.gardenDir === undefined ? path.join(agentRoot, "garden", path.basename(subdirs[i])) : opts.gardenDir;
    const items = await headsToItems(filesPerDir[i], gardenDir, {
      ...opts,
      onProgress: () => {
        loaded++;
        opts.onProgress?.(loaded, total);
      },
    });
    all.push(...items);
  }
  return all;
}
