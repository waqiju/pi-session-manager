/**
 * 会话列表的展示格式化（纯函数，零依赖，node --test 直测）。
 *
 * 从 extensions/garden-selector.ts 下沉：目录索引（src/index-page.ts，CLI 侧）与
 * 子树复制（extensions/garden-clipboard.ts，扩展侧）共用，故放 src/ 供两端引用。
 */

import type { SessionListItem } from "./session-list.ts";
import { truncateToWidth } from "./textwidth.ts";

/** 文件大小标签：500B / 8KB / 1.2MB；null（文件不存在等）→ "?" */
export function formatSizeLabel(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** YYYY-MM-DD（本地时区）；导出文本用绝对日期——相对时间（"2d"）在落盘后失真 */
export function formatDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 短日期（本地时区）：与 now 同年 → MM-DD，否则完整 YYYY-MM-DD。索引页给人看近况，当年省年份 */
export function formatDateShort(d: Date, now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 摘要清洗：控制字符/换行 → 空格，折叠空白 */
export function cleanInline(t: string): string {
  return t.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/** 标签列宽上限（含省略号）：命名会话 48 列；无名摘要 36 列（散文 prompt 是主要噪音源，收更紧） */
export const LABEL_MAX_COLS = 48;
export const EXCERPT_MAX_COLS = 36;

/** 节点标签：name 优先（超 48 列截断）；无名回退首条用户消息摘要（36 列截断，加引号区别于命名）；皆无 → untitled */
export function nodeLabel(s: SessionListItem): string {
  const name = cleanInline(s.name ?? "");
  if (name) return truncateToWidth(name, LABEL_MAX_COLS, "…");
  const excerpt = cleanInline(s.firstMessage ?? "");
  return excerpt ? `"${truncateToWidth(excerpt, EXCERPT_MAX_COLS, "…")}"` : "untitled";
}
