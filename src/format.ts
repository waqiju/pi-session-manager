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

/** 摘要清洗：控制字符/换行 → 空格，折叠空白 */
export function cleanInline(t: string): string {
  return t.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/** 节点标签：name 优先；无名回退首条用户消息摘要（~50 列截断，加引号区别于命名）；皆无 → untitled */
export function nodeLabel(s: SessionListItem): string {
  const name = cleanInline(s.name ?? "");
  if (name) return name;
  const excerpt = cleanInline(s.firstMessage ?? "");
  return excerpt ? `"${truncateToWidth(excerpt, 50, "…")}"` : "untitled";
}
