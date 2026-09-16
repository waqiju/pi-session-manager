/**
 * /garden 选择器的子树复制（Ctrl+Y）：生成自解释文本并复制到系统剪贴板，
 * 粘贴给其他 AI 作 context。零运行时 pi 依赖（node --test 可直测）。
 */

import { spawnSync } from "node:child_process";
import { formatDate, formatSizeLabel, nodeLabel } from "../src/format.ts";
import type { SessionListItem } from "../src/session-list.ts";
import type { FlatNode } from "../src/session-tree.ts";

/** 子树复制上限（防误把巨型树塞进剪贴板；超出硬拒，不截断） */
export const COPY_SUBTREE_MAX = 99;

/** 复制文本里单个 session 的文件信息（调用方解析：组件 = 最高存在级别 + statSync） */
export interface SubtreeFileInfo {
  /** 实际存在的最高级别 md 绝对路径（级别由扩展名标示） */
  path: string;
  /** 文件大小（字节）；stat 失败为 null → 显示 "?" */
  size: number | null;
}

/**
 * 子树复制文本（粘贴给其他 AI 作 context）：自解释头部 + 编号树（内联元数据）+ 绝对路径清单。
 * 设计要点：
 * - 目标 AI 零背景可读：头部说清 fork 语义 / 编号对应 / l1-l3 级别规则；
 * - 不读文件即可判断相关性：树行内联 名称/msgs/size/日期；
 * - [n] 编号对齐树节点与路径（模型不擅长数行数）；
 * - 绝对路径（部分读文件工具不展开 ~）；
 * - 日期用绝对值（相对时间在粘贴后失真）。
 * flat = flattenSessionTree([子树根]) 的结果（depth 相对子树根）；只 stat 不读正文。
 */
export function buildSubtreeCopyText(flat: FlatNode[], resolveFile: (item: SessionListItem) => SubtreeFileInfo): string {
  const infos = flat.map((n) => resolveFile(n.session));
  const known = infos.filter((i) => i.size !== null).length;
  const total = known > 0 ? ` · 合计 ~${formatSizeLabel(infos.reduce((a, i) => a + (i.size ?? 0), 0))}` : "";
  const root = flat[0].session;
  const lines: string[] = [
    `# 会话子树索引（共 ${flat.length} 条对话${total} · 项目 ${root.cwd}）`,
    "",
    "一组关联 AI 对话的索引：子会话由父会话 fork（继承其上下文起点）。每条对话的完整内容",
    "是下方同编号的本地 md 文件，可直接用工具读取。同名 .l1.md（如存在）比 .l3.md 含更多",
    "工具调用与推理细节。请按名称/消息数/大小/日期选读。",
    "",
    "## 树",
    "",
  ];
  flat.forEach((n, i) => {
    const meta = `${n.session.messageCount} msgs · ${formatSizeLabel(infos[i].size)} · ${formatDate(n.session.modified)}`;
    if (i === 0) {
      lines.push(`[1] ${nodeLabel(n.session)} — ${meta}`);
      return;
    }
    // 前缀跳过 ancestorContinues 首槽（子树根一级，屏幕上用于缩进对齐，导出文本顶格即可）
    const parts = n.ancestorContinues.slice(1).map((c) => (c ? "│  " : "   "));
    lines.push(`${parts.join("")}${n.isLast ? "└─ " : "├─ "}[${i + 1}] ${nodeLabel(n.session)} — ${meta}`);
  });
  lines.push("", "## 文件", "");
  flat.forEach((n, i) => lines.push(`[${i + 1}] ${infos[i].path}`));
  return lines.join("\n") + "\n";
}

/**
 * 平台剪贴板复制：pbcopy（macOS）/ clip.exe（WSL）/ wl-copy（Wayland）/ xclip（X11）。
 * spawnSync 同步喂 stdin，3s 超时；全部不可用返回 error 供选择器 toast。
 */
export function copyToClipboard(text: string): { ok: boolean; error?: string } {
  const cmds: [string, string[]][] = [];
  if (process.platform === "darwin") {
    cmds.push(["pbcopy", []]);
  } else if (process.env.WSL_DISTRO_NAME) {
    cmds.push(["clip.exe", []]);
  } else {
    if (process.env.WAYLAND_DISPLAY) cmds.push(["wl-copy", []]);
    cmds.push(["xclip", ["-selection", "clipboard"]]);
  }
  for (const [cmd, args] of cmds) {
    try {
      const r = spawnSync(cmd, args, { input: text, timeout: 3000 });
      if (r.status === 0) return { ok: true };
    } catch {
      /* 命令不存在等，试下一个 */
    }
  }
  return { ok: false, error: "无可用剪贴板命令（尝试 pbcopy/clip.exe/xclip/wl-copy）" };
}
