/**
 * garden 目录索引页（index.md）生成。
 *
 * 每个 garden 项目目录一份 index.md：fork 森林（多棵会话树，按最近活跃降序）+
 * markdown 嵌套列表（缩进 = fork 层级），每行内联 名称/消息数/大小/日期，链接为
 * 相对路径（编辑器可点击；garden 目录跨机器同步/git 提交时绝对路径会失效）。
 *
 * 生成时机（索引与产物的一致性边界）：
 *   CLI 转换 / --sync 收尾     → 有写入/清理/缺 index 的目录重建
 *   /gardener-output index     → 显式重建当前项目目录
 *   /gardener-open index       → 重建后打开（打开即最新）
 *   扩展 live 自动转换          → 不重建（避免每次 settle 全目录扫描；打开前必重建兜底）
 *
 * index.md 不匹配 *.lN.md 模式，列表加载（session-list.ts）与清理
 * （cli.ts indexOutputsBySessionId / syncCleanup）都会自然忽略它。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatDate, formatSizeLabel, nodeLabel } from "./format.ts";
import { pickHighestLevelFile } from "./open.ts";
import { listProjectSessions, type SessionListItem } from "./session-list.ts";
import { basenameAny, buildSessionTree, flattenSessionTree } from "./session-tree.ts";

export const INDEX_FILE_NAME = "index.md";

/** 索引行链接目标（调用方解析；index.md 场景 = 相对 href + 文件大小） */
export interface IndexFileInfo {
  /** 相对 index.md 所在目录的链接目标（如 ./2026-09-14-001-PSM.l3.md） */
  href: string;
  /** 链接文件的字节数；stat 失败 null → 显示 "?" */
  size: number | null;
}

/** markdown 链接文本转义：label 来自用户命名，可能含 [ ] */
function escapeLinkLabel(label: string): string {
  return label.replace(/([[\]])/g, "\\$1");
}

/** 项目 cwd：取 items 里出现次数最多的（防个别 session 的 cwd 抖动）；无 → "" */
function projectCwd(items: SessionListItem[]): string {
  const count = new Map<string, number>();
  let best = "";
  for (const s of items) {
    if (!s.cwd) continue;
    const n = (count.get(s.cwd) ?? 0) + 1;
    count.set(s.cwd, n);
    if (n > (count.get(best) ?? 0)) best = s.cwd;
  }
  return best;
}

/**
 * 目录索引页文本（纯函数）。items = 该 garden 目录的全部会话（listProjectSessions）。
 * 布局：标题 + 统计行 + 说明块 + fork 森林（嵌套列表；树与树之间空行分隔）。
 */
export function buildIndexPage(items: SessionListItem[], resolveFile: (item: SessionListItem) => IndexFileInfo): string {
  const roots = buildSessionTree(items);
  const flat = flattenSessionTree(roots);
  const cwd = projectCwd(items);
  const title = cwd ? `# 会话索引 — ${basenameAny(cwd.replace(/[/\\]+$/, ""))}` : "# 会话索引";
  const lines: string[] = [
    title,
    "",
    `共 ${flat.length} 条对话 · ${roots.length} 棵会话树${cwd ? ` · 项目 \`${cwd}\`` : ""}`,
    "",
    "> 本目录是该项目全部 AI 会话的 markdown 归档（文件名 `<日期>-<序号>-<slug>.lN.md`）。",
    "> 子会话由父会话 fork（继承其上下文起点），缩进表示 fork 层级；各树按最近活跃降序。",
    "> 链接为相对路径，指向该对话的最高级别导出（l3 纯问答）；同名 .l1.md（如存在）含更多",
    "> 工具调用与推理细节。",
    "",
  ];
  for (const n of flat) {
    const info = resolveFile(n.session);
    const meta = `${n.session.messageCount} msgs · ${formatSizeLabel(info.size)} · ${formatDate(n.session.modified)}`;
    // href 加 <>：文件名可能含空格/括号（裸 ( ) 会截断 markdown 链接目标）
    const row = `- [${escapeLinkLabel(nodeLabel(n.session))}](<${info.href}>) — ${meta}`;
    if (n.depth === 0 && lines[lines.length - 1] !== "") lines.push(""); // 树间空行（渲染上拉开间距）
    lines.push(`${"  ".repeat(n.depth)}${row}`);
  }
  return lines.join("\n") + "\n";
}

export interface DirIndexResult {
  /** index.md 绝对路径 */
  file: string;
  /** 会话条数 */
  sessions: number;
  /** 会话树棵数 */
  roots: number;
  /** 本次是否实际写盘（内容无变化时跳过，避免 mtime 抖动/git diff 噪音） */
  changed: boolean;
}

/**
 * 重建一个 garden 项目目录的 index.md。
 * 数据源 = 目录内 md 产物（frontmatter only，不读正文）；无会话 → null（不写空索引）。
 * 链接目标 = 该会话实际存在的最高级别 md（l3>l2>l1>l0，与选择器一致）。
 */
export async function generateDirIndex(dir: string): Promise<DirIndexResult | null> {
  const items = await listProjectSessions(dir, { fullText: false });
  if (items.length === 0) return null;
  const roots = buildSessionTree(items);
  const content = buildIndexPage(items, (item) => {
    const abs = pickHighestLevelFile(dir, item.mdBase) ?? path.join(dir, `${item.mdBase}.l3.md`);
    let size: number | null = null;
    try {
      size = statSync(abs).size;
    } catch {
      /* 文件不存在等 → null */
    }
    return { href: `./${path.basename(abs)}`, size };
  });
  const file = path.join(dir, INDEX_FILE_NAME);
  if (existsSync(file) && readFileSync(file, "utf-8") === content) {
    return { file, sessions: items.length, roots: roots.length, changed: false };
  }
  writeFileSync(file, content);
  return { file, sessions: items.length, roots: roots.length, changed: true };
}
