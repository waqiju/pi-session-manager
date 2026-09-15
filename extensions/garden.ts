/**
 * garden — pi 扩展。
 *
 * 一、自动转换：会话生命周期内把当前 session .jsonl 转成三级 markdown（l0/l1/l2）。
 *   渲染核心在 ../src（CLI 同源），这里只做事件接线：
 *     session_start    → 补漏（crash / kill 后恢复）
 *     agent_settled    → live 转换（防抖，默认 60s，PI_GARDEN_LIVE_INTERVAL_S 调整，0 关闭）
 *     session_compact  → compaction 章节边界
 *     session_shutdown → 终态保证（quit / new / resume / fork / reload 都会触发）
 *   增量判断（mtime + GARDEN_VERSION）在 processFile 内，重复触发几乎零成本。
 *
 * 二、命令：
 *   /garden            → 快速 session 选择器（等位 /resume：fork 树/搜索/删除/重命名，
 *                        但列表只读文件头 + garden frontmatter 富化，慢盘友好）
 *   /gardener-output   → 转换当前 session（all = 全量回填 sessions 树）
 *   /gardener-open [lN]→ 默认浏览器打开当前 session 的 garden md（默认最高存在级别）
 *
 * 配置（env）：
 *   PI_GARDEN=0                     完全停用本扩展
 *   PI_GARDEN_LIVE_INTERVAL_S=60    live 转换最小间隔（秒，可小数）；0 = 关闭 live 触发
 *   PI_GARDEN_OPEN_CMD              自定义打开命令（空格切分；{file} 占位，缺省追加为末参）
 *
 * 注意：factory 只在会话加载时运行；不在此处起 timer / watcher（pi 扩展约束）。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectJobs, pathsForFile, prepareGroup, processFile } from "../src/cli.ts";
import { GARDEN_LEVELS, isGardenLevel, openFile, pickHighestLevelFile, type GardenLevel } from "../src/open.ts";
import { listAllSessions, listProjectSessions } from "../src/session-list.ts";

export interface GardenConfig {
  enabled: boolean;
  /** live 触发最小间隔（ms）；0 = 关闭 */
  liveIntervalMs: number;
}

export function readConfig(env: NodeJS.ProcessEnv): GardenConfig {
  const off = (env.PI_GARDEN ?? "").trim() === "0";
  let liveIntervalMs = 60_000;
  const raw = (env.PI_GARDEN_LIVE_INTERVAL_S ?? "").trim();
  if (raw !== "") {
    const n = Number(raw);
    liveIntervalMs = Number.isFinite(n) && n > 0 ? n * 1000 : 0;
  }
  return { enabled: !off, liveIntervalMs };
}

/**
 * 只接受 pi 标准布局 .../sessions/<sub>/<file>.jsonl，返回 { sub, outRoot }；
 * 其余（非常规 session 路径）返回 null —— 防御把 garden 写到莫名其妙的目录。
 */
export function gardenPathsFor(sessionFile: string): { sub: string; outRoot: string } | null {
  if (!sessionFile.endsWith(".jsonl")) return null;
  const sessionsDir = path.dirname(path.dirname(sessionFile));
  if (path.basename(sessionsDir) !== "sessions") return null;
  return pathsForFile(sessionFile);
}

/** 转换单个 session 文件；非常规布局或文件不存在返回 null */
export function convertSessionFile(sessionFile: string): { written: string[]; skipped: string[] } | null {
  const p = gardenPathsFor(sessionFile);
  if (!p || !existsSync(sessionFile)) return null;
  const outDir = path.join(p.outRoot, p.sub);
  const prepared = prepareGroup([{ src: sessionFile, sub: p.sub }], () => {});
  if (prepared.length === 0) return null;
  return processFile(prepared[0], outDir);
}

export default function (pi: ExtensionAPI) {
  const cfg = readConfig(process.env);
  if (!cfg.enabled) return;

  let lastConvertAt = 0;
  let lastErrorMsg = "";

  function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning"): void {
    if (ctx.hasUI) ctx.ui.notify(msg, level);
  }

  /** 各触发点共用的转换入口；返回给人看的简报（仅命令用得上） */
  function convertCurrent(ctx: ExtensionContext): string | null {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return null; // ephemeral session，无文件可转
    lastConvertAt = Date.now();
    try {
      const res = convertSessionFile(file);
      if (!res) return null; // 非常规布局，静默跳过
      lastErrorMsg = "";
      return res.written.length ? `garden: 已更新 ${res.written.map((l) => `.${l}.md`).join(" ")}` : "garden: 已是最新";
    } catch (e) {
      const msg = `garden 转换失败: ${(e as Error).message}`;
      if (msg !== lastErrorMsg) {
        lastErrorMsg = msg;
        notify(ctx, msg, "warning"); // 相同错误只报一次，避免 live 触发刷屏
      }
      return null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    convertCurrent(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    convertCurrent(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    convertCurrent(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!cfg.liveIntervalMs) return;
    if (Date.now() - lastConvertAt < cfg.liveIntervalMs) return;
    convertCurrent(ctx);
  });

  pi.registerCommand("gardener-output", {
    description: "转换当前 session 到 garden（/gardener-output all = 全量回填 sessions 树）",
    handler: async (args, ctx) => {
      if (args.trim() === "all") {
        const file = ctx.sessionManager.getSessionFile();
        const sessionsDir = file ? path.dirname(path.dirname(file)) : path.join(process.env.HOME ?? "", ".pi", "agent", "sessions");
        if (!existsSync(sessionsDir)) {
          notify(ctx, `garden: sessions 目录不存在: ${sessionsDir}`, "warning");
          return;
        }
        const { jobs, defaultOut } = collectJobs(sessionsDir);
        let updated = 0;
        let failed = 0;
        const prepared = prepareGroup(jobs, () => { failed++; });
        for (const p of prepared) {
          try {
            if (processFile(p, path.join(defaultOut, p.job.sub)).written.length) updated++;
          } catch {
            failed++;
          }
        }
        notify(ctx, `garden all: ${jobs.length} 个 session，${updated} 更新${failed ? `，${failed} 失败` : ""} → ${defaultOut}`, failed ? "warning" : "info");
        return;
      }
      const msg = convertCurrent(ctx);
      notify(ctx, msg ?? "garden: 当前会话无可转换的 session 文件", "info");
    },
  });

  pi.registerCommand("gardener-open", {
    description: `默认浏览器打开当前 session 的 garden md（默认最高存在级别；可用 ${GARDEN_LEVELS.join("/")} 指定）`,
    handler: async (args, ctx) => {
      const levelArg = args.trim();
      if (levelArg && !isGardenLevel(levelArg)) {
        notify(ctx, `gardener-open: 未知级别 "${levelArg}"（可选 ${GARDEN_LEVELS.join("/")}）`, "warning");
        return;
      }
      const file = ctx.sessionManager.getSessionFile();
      if (!file) {
        notify(ctx, "gardener-open: 当前会话无 session 文件", "warning");
        return;
      }
      const p = gardenPathsFor(file);
      if (!p) {
        notify(ctx, "gardener-open: 非常规 session 路径，无法推导 garden 目录", "warning");
        return;
      }
      const base = path.basename(file, ".jsonl");
      const mdDir = path.join(p.outRoot, p.sub);
      const level = (levelArg || undefined) as GardenLevel | undefined;
      // 输出文件名含计算出的命名 slug（如 2026-09-14-001-garden_开发会话），需用 prepareGroup 获取
      let computeBase = (): string => base; // fallback: 直接用原始 basename
      try {
        const prepared = prepareGroup([{ src: file, sub: p.sub }], () => {});
        if (prepared.length > 0) computeBase = () => prepared[0].base;
      } catch { /* 命名失败时退回原始 basename */ }
      let target = pickHighestLevelFile(mdDir, computeBase(), level);
      if (!target && !levelArg) convertCurrent(ctx); // 无产物：先转换再取（指定级别不存在时不白转）
      if (!target) target = pickHighestLevelFile(mdDir, computeBase(), level);
      if (!target) {
        notify(ctx, `gardener-open: 无 ${levelArg || "任何级别"} 的输出文件`, "warning");
        return;
      }
      const r = await openFile(target, process.env);
      notify(ctx, r.ok ? `gardener-open: 已打开 ${path.basename(target)}` : `gardener-open 失败: ${r.detail}`, r.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("garden", {
    description: "快速 session 选择器（等位 /resume；列表只读文件头，慢盘友好）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(ctx, "garden: 选择器需要 TUI/RPC 模式", "warning");
        return;
      }
      // 动态 import：仅在选择器真正打开时才加载 pi 包（保持本文件可被零依赖测试）
      const { SessionSelectorComponent, SessionManager } = (await import("@earendil-works/pi-coding-agent")) as any;
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessionsRoot = path.dirname(sessionDir);
      const currentFile = ctx.sessionManager.getSessionFile();
      const picked = await ctx.ui.custom<string | null>(
        (tui, _theme, keybindings, done) =>
          new SessionSelectorComponent(
            (onProgress: (loaded: number, total: number) => void) => listProjectSessions(sessionDir, { onProgress }),
            (onProgress: (loaded: number, total: number) => void) => listAllSessions(sessionsRoot, { onProgress }),
            (p: string) => done(p),
            () => done(null),
            () => done(null),
            () => tui.requestRender(),
            {
              keybindings,
              showRenameHint: true,
              renameSession: async (p: string, name: string | null) => {
                const next = (name ?? "").trim();
                if (!next) return;
                SessionManager.open(p).appendSessionInfo(next); // 与内建 /resume 同一实现路径
              },
            },
            currentFile ?? undefined,
          ),
      );
      if (!picked) return;
      try {
        await ctx.switchSession(picked);
      } catch (e) {
        notify(ctx, `garden: 切换 session 失败: ${(e as Error).message}`, "warning");
      }
    },
  });
}
