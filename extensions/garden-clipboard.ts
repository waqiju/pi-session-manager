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
 * 子树复制文本（粘贴给其他 AI 作 context）：关联会话头部 + Agent 查阅指南 + 编号树
 * （内联元数据）+ 详情清单（名称/元数据/绝对路径）。
 * 设计要点：
 * - 💡 查阅指南是给接收 Agent 的行动指令：先按会话树挑 1-2 个节点读 l3 掌握上下文，
 *   需要代码路径/工具日志再 grep 同名 l1——避免拿到 context 却跳过指引、直接去
 *   全代码库搜索走弯路（2026-09-17 实测：旧模板措辞是"按需选读"，agent 忽略参考
 *   资料转而大范围 grep，两轮独立会话重复同一弯路）；
 * - 不读文件即可判断相关性：树行内联 名称/msgs/size/日期；
 * - [n] 编号对齐树节点与详情条目（模型不擅长数行数）；
 * - 绝对路径（部分读文件工具不展开 ~）；
 * - 日期用绝对值（相对时间在粘贴后失真）。
 * flat = flattenSessionTree([子树根]) 的结果（depth 相对子树根）；只 stat 不读正文。
 */
export function buildSubtreeCopyText(flat: FlatNode[], resolveFile: (item: SessionListItem) => SubtreeFileInfo): string {
  const infos = flat.map((n) => resolveFile(n.session));
  const known = infos.filter((i) => i.size !== null).length;
  const total = known > 0 ? ` · ${formatSizeLabel(infos.reduce((a, i) => a + (i.size ?? 0), 0))}` : "";
  const lines: string[] = [
    `🗂️ 关联历史会话 (${flat.length} 条${total})`,
    "💡 Agent 查阅指南：",
    "1. 锁定线索：执行代码搜索前，请先结合下方的会话树挑选 1-2 个最相关的节点。",
    "2. 渐进挖掘：优先使用工具直接读取下方对应的 `.l3.md` 掌握上下文。",
    "3. 深入细节：若需具体代码路径或执行日志，再 `grep` 同名的 `.l1.md`（将下方路径后缀改为 .l1.md 即可）。",
    "",
    "🌲 会话树",
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
  lines.push("", "📄 详情与文件");
  flat.forEach((n, i) => {
    if (i > 0) lines.push("");
    const meta = `${n.session.messageCount} msgs · ${formatSizeLabel(infos[i].size)} · ${formatDate(n.session.modified)}`;
    lines.push(`[${i + 1}] ${nodeLabel(n.session)} (${meta})`, infos[i].path);
  });
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
