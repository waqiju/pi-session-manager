/**
 * 终端文本宽度工具（零依赖）：garden 自绘选择器用。
 *
 * 与 pi-tui 的 visibleWidth / truncateToWidth 语义对齐，但本文件不 import 任何
 * pi 包 —— 保持 src/ 零依赖，node --test 可直接测。
 * 宽度规则：ANSI 转义序列占 0 宽；东亚宽字符（CJK 等）占 2 列；其余占 1 列。
 */

/** ANSI CSI/OSC 等转义序列（strip 后计宽） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]()][^\x07]*\x07?/g;

/** 去掉 ANSI 转义序列 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * 宽字符（占 2 列）判断：覆盖常见 East Asian Wide/Fullwidth 区段。
 * 与 pi-tui / wcwidth 的常见实现一致；边缘区段（罕见 script）按 1 列处理，可接受。
 */
export function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK Radicals .. Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

/** 字符串显示宽度（列数；ANSI 序列不计） */
export function visibleWidth(text: string): number {
  let w = 0;
  const plain = stripAnsi(text);
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    w += isWideCodePoint(cp) ? 2 : 1;
  }
  return w;
}

/**
 * 按显示宽度截断（保留 ANSI 序列；超宽时在预算内追加省略号）。
 * 截断点不落在宽字符中间（宁可少放一个字符）；预算不足返回原串。
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
  if (visibleWidth(text) <= maxWidth) return text;
  const budget = Math.max(0, maxWidth - visibleWidth(ellipsis));
  let out = "";
  let w = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*[a-zA-Z]|^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|^\x1b[^\[\]()][^\x07]*\x07/.exec(text.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = isWideCodePoint(cp) ? 2 : 1;
    if (w + cw > budget) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  // 截断发生在带样式的串中间：补 reset，防颜色/背景泄漏到后续内容
  const reset = out.includes("\x1b[") ? "\x1b[0m" : "";
  return out + reset + ellipsis;
}
