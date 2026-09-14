/**
 * 机械截断：line 级（l0 → l1）。
 *
 * 规则：
 * - 文本 <= budget：原样返回（块级阈值）
 * - 否则按 6:4 分头/尾预算；从两端 greedy 拿**整行**，累计 >= 预算即停，
 *   跨越预算边界的行完整保留（宁多不少，绝不截断在行中间）
 * - 头尾行数覆盖全部行（重叠）→ 返回原文，不做无意义截断
 * - 中间插入标记："... (omitted X chars / Y lines) ..."
 *
 * 已知行为：单行超长块会整行保留（等以后的 inline 级截断处理）。
 */

export interface LineTruncateOptions {
  /** 头部预算占比，默认 0.6（尾部 0.4） */
  headRatio?: number;
}

/** 各级块的预算（字符）。调参只改这里，改完 bump GARDEN_VERSION */
export const TOOL_RESULT_BUDGET = 1000;
export const TOOL_ARG_BUDGET = 800;
export const THINKING_BUDGET = 1000;
/** edit 等工具的 details（diff/patch 是实质内容，多留） */
export const DETAILS_BUDGET = 4000;
export const CUSTOM_DATA_BUDGET = 2000;

export function truncateLines(text: string, budget: number, opts: LineTruncateOptions = {}): string {
  if (text.length <= budget) return text;
  const headRatio = opts.headRatio ?? 0.6;
  const lines = text.split("\n");
  // 行长按 line.length + 1（换行符）计
  const headBudget = budget * headRatio;
  const tailBudget = budget * (1 - headRatio);

  let headCount = 0;
  let headChars = 0;
  while (headCount < lines.length) {
    headChars += lines[headCount].length + 1;
    headCount++;
    if (headChars >= headBudget) break;
  }

  let tailCount = 0;
  let tailChars = 0;
  while (tailCount < lines.length - headCount) {
    tailChars += lines[lines.length - 1 - tailCount].length + 1;
    tailCount++;
    if (tailChars >= tailBudget) break;
  }

  // 重叠：截断无意义，返回原文
  if (headCount + tailCount >= lines.length) return text;

  const headText = lines.slice(0, headCount).join("\n");
  const tailText = lines.slice(lines.length - tailCount).join("\n");
  const omittedChars = text.length - headText.length - tailText.length;
  const omittedLines = lines.length - headCount - tailCount;
  return `${headText}\n\n... (omitted ${omittedChars} chars / ${omittedLines} lines) ...\n\n${tailText}`;
}

/** 深遍历 JSON：字符串值超预算则 line 级截断（用于 toolCall arguments / details / custom data） */
export function truncateLongStrings(value: unknown, budget: number): unknown {
  if (typeof value === "string") return truncateLines(value, budget);
  if (Array.isArray(value)) return value.map((v) => truncateLongStrings(v, budget));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateLongStrings(v, budget);
    return out;
  }
  return value;
}
