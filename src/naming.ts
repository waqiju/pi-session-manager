/**
 * 输出文件命名：从 session 内容推导人类可读的 base name（不含 .<level>.md 后缀）。
 *
 * 格式：<本地日期>-<序号>-<slug>
 *   2026-08-31-001-禁用进程-CPU占用高
 *
 * - 日期：session 开始时间按运行机器本地时区取 YYYY-MM-DD（人按本地时间回忆会话）
 * - 序号：同一输出目录内按日期分组，组内按开始时间升序，从 001 起（编号是组内
 *   全局属性，所以命名必须以组为单位计划，见 cli.ts prepareGroup）
 * - slug：最后一条 session_info.name（改名 last wins），无 → "untitled"
 */
import path from "node:path";
import type { Entry, SessionHeader } from "./types.ts";

/** 未命名 session 的 slug */
export const UNTITLED = "untitled";
/** slug 长度上限（code point 数；文件名是标识符，超长硬切） */
export const SLUG_MAX_CHARS = 40;

/** 空白（含换行）连续段 → 单个 _ */
const WHITESPACE_RE = /\s+/g;
/** Windows 非法字符 + 控制字符，连续段 → 单个 _ */
const ILLEGAL_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]+/g;

/** 会话名 → 文件名安全 slug：空白/非法字符 → _，尾部 . 去掉（Windows 不允许），超长截断 */
export function slugifyName(name: string | null | undefined): string {
  let s = (name ?? "").trim().replace(WHITESPACE_RE, "_").replace(ILLEGAL_CHARS_RE, "_");
  // Array.from 按 code point 切，不劈开代理对（emoji）
  s = Array.from(s).slice(0, SLUG_MAX_CHARS).join("").replace(/\.+$/, "");
  return s || UNTITLED;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** ISO 时间戳 → 本地日期 "YYYY-MM-DD"（时区 = 运行机器；输出为人类阅读服务） */
export function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export interface NamingInfo {
  /** 源文件绝对路径（planBaseNames 返回值的 key） */
  src: string;
  /** session id（header.id，兜底源文件名去扩展名）；旧命名文件清理的匹配依据 */
  id: string;
  /** 排序与取日期用的时间戳（UTC ISO） */
  timestamp: string;
  /** 最后一条 session_info 的 name；无 → null */
  name: string | null;
}

/** pi 源文件名的时间戳前缀：2026-08-31T05-22-47-931Z_... */
const FILENAME_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,3}))?Z/;

function timestampFromFilename(src: string): string | null {
  const m = path.basename(src).match(FILENAME_TS_RE);
  if (!m) return null;
  const ms = (m[7] ?? "0").padEnd(3, "0");
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
}

/** 从解析结果提取命名要素。timestamp 兜底链：header → 源文件名前缀 → 文件 mtime */
export function extractNamingInfo(
  src: string,
  header: SessionHeader | null,
  entries: Entry[],
  srcMtimeMs: number,
): NamingInfo {
  let name: string | null = null;
  for (const e of entries) {
    if (e.type === "session_info") name = (e as { name?: string }).name ?? null;
  }
  let timestamp = header?.timestamp || timestampFromFilename(src);
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    timestamp = new Date(srcMtimeMs).toISOString();
  }
  return { src, id: header?.id || path.basename(src).replace(/\.jsonl$/, ""), timestamp, name };
}

/**
 * 同组（同一输出目录）session 的命名计划：按时间排序，每个本地日期从 001 编号。
 * 排序 tiebreak：timestamp → id → src，保证确定性。
 */
export function planBaseNames(infos: NamingInfo[]): Map<string, string> {
  const sorted = [...infos].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id) || a.src.localeCompare(b.src),
  );
  const counters = new Map<string, number>();
  const out = new Map<string, string>();
  for (const info of sorted) {
    const date = localDate(info.timestamp);
    const n = (counters.get(date) ?? 0) + 1;
    counters.set(date, n);
    out.set(info.src, `${date}-${String(n).padStart(3, "0")}-${slugifyName(info.name)}`);
  }
  return out;
}
