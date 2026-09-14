/**
 * 机械截断：inline 级 + line 级（l0 → l1）。
 *
 * inline 级（行内）：
 * - 任何一行 > inlineLimit（默认 500）→ 头尾截断：`<head> ... (omitted X chars) ... <tail>`
 * - head 侧软断行：切点后向后最多 40 字符找空白/逗号再断（找不到才硬切），延续「宁多不少」
 * - tail 侧硬切
 *
 * line 级（块）：
 * - 先做 inline（逐行预处理），再对块做 line 级。两层独立可组合
 * - 块 <= budget：inline 处理后直接返回（小块里的超长行也会被 inline 截断）
 * - 否则按 6:4 分头/尾预算；从两端 greedy 拿**整行**，累计 >= 预算即停，
 *   跨越预算边界的行完整保留（宁多不少）
 * - 头尾行数覆盖全部行（重叠）→ 返回 inline 处理后的原文
 * - 中间插入标记："... (omitted X chars / Y lines) ..."（字符数按 inline 处理后的文本计）
 */

export interface LineTruncateOptions {
  /** 头部预算占比，默认 0.6（尾部 0.4） */
  headRatio?: number;
  /** 单行封顶，默认 INLINE_LIMIT */
  inlineLimit?: number;
}

/** 各级块的预算（字符）。调参只改这里，改完 bump GARDEN_VERSION */
export const TOOL_RESULT_BUDGET = 1000;
export const TOOL_ARG_BUDGET = 800;
export const THINKING_BUDGET = 1000;
/** edit 等工具的 details（diff/patch 是实质内容，多留） */
export const DETAILS_BUDGET = 4000;
export const CUSTOM_DATA_BUDGET = 2000;

/** inline 级：单行封顶 */
export const INLINE_LIMIT = 500;
/** inline 级：head 软断行向后找分隔符的上限已取消（永不硬切） */
/** inline 级：省略量低于该值则不截（至少省出一个 marker 的量级，否则只增噪声） */
export const INLINE_MIN_OMIT = 64;

const SOFT_BREAK_CHARS = new Set([" ", ",", "\t", "，", "、", "；", ";"]);

/**
 * 行内截断：行 <= limit 原样返回；否则 head + marker + tail。
 * 永不硬切：head 从切点向后找最近分隔符断在其前；tail 从切点向前找最近分隔符始于其后。
 * 找不到分隔符（无空白/逗号的行）或头尾断点交叉 → 整行保留。
 */
export function truncateInline(line: string, limit = INLINE_LIMIT, headRatio = 0.6): string {
  if (line.length <= limit) return line;
  const head = Math.round(limit * headRatio);
  const tail = limit - head;
  // head：从 head 向后找分隔符，断在其前（不含分隔符）
  let cut = -1;
  for (let i = head; i < line.length; i++) {
    if (SOFT_BREAK_CHARS.has(line[i])) {
      cut = i;
      break;
    }
  }
  // tail：从 tailStart 向前找分隔符，tail 从其后开始（宁多不少）
  const tailStart = line.length - tail;
  let tailFrom = -1;
  for (let i = tailStart - 1; i >= 0; i--) {
    if (SOFT_BREAK_CHARS.has(line[i])) {
      tailFrom = i + 1;
      break;
    }
  }
  if (cut === -1 || tailFrom === -1 || cut >= tailFrom) return line;
  const omitted = tailFrom - cut;
  if (omitted < INLINE_MIN_OMIT) return line;
  return `${line.slice(0, cut)} ... (omitted ${omitted} chars) ... ${line.slice(tailFrom)}`;
}

export function truncateLines(text: string, budget: number, opts: LineTruncateOptions = {}): string {
  const headRatio = opts.headRatio ?? 0.6;
  const inlineLimit = opts.inlineLimit ?? INLINE_LIMIT;
  // inline 级：逐行封顶（先行处理，line 级面对的是处理后的行）
  const lines = text.split("\n").map((l) => truncateInline(l, inlineLimit, headRatio));

  // 块级阈值：inline 处理后不超预算 → 直接返回
  const processedLen = lines.reduce((a, l) => a + l.length + 1, 0) - 1;
  if (processedLen <= budget) return lines.join("\n");

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

  // 重叠：截断无意义，返回 inline 处理后的原文
  if (headCount + tailCount >= lines.length) return lines.join("\n");

  const headText = lines.slice(0, headCount).join("\n");
  const tailText = lines.slice(lines.length - tailCount).join("\n");
  const omittedChars = processedLen - headText.length - tailText.length;
  const omittedLines = lines.length - headCount - tailCount;
  return `${headText}\n\n... (omitted ${omittedChars} chars / ${omittedLines} lines) ...\n\n${tailText}`;
}

/** 深遍历 JSON：字符串值超预算则截断（用于 toolCall arguments / details / custom data） */
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

/**
 * 对已渲染文本逐行做 inline 截断。
 * 用于 JSON.stringify 后的物理行：字符串值里的换行被转义成 \n 字面量，
 * 整个值合并成一条超长物理行（即使值本身已被 truncateLines 截短）。
 */
export function truncateEachLine(text: string, limit = INLINE_LIMIT): string {
  return text.split("\n").map((l) => truncateInline(l, limit)).join("\n");
}
