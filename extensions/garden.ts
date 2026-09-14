/**
 * garden — pi 扩展：会话生命周期内自动把当前 session .jsonl 转成三级 markdown（l0/l1/l2）。
 *
 * 渲染核心在 ../src（CLI 同源），本文件只做事件接线：
 *   session_start    → 补漏（crash / kill 后恢复）
 *   agent_settled    → live 转换（防抖，默认 60s，PI_GARDEN_LIVE_INTERVAL_S 调整，0 关闭）
 *   session_compact  → compaction 章节边界
 *   session_shutdown → 终态保证（quit / new / resume / fork / reload 都会触发）
 *   /garden [all]    → 手动转换当前 session；all = 全量回填整个 sessions 树
 *
 * 增量判断（mtime + GARDEN_VERSION）在 processFile 内，重复触发几乎零成本。
 *
 * 配置（env）：
 *   PI_GARDEN=0                     完全停用本扩展
 *   PI_GARDEN_LIVE_INTERVAL_S=60    live 转换最小间隔（秒，可小数）；0 = 关闭 live 触发
 *
 * 注意：factory 只在会话加载时运行；不在此处起 timer / watcher（pi 扩展约束）。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectJobs, pathsForFile, processFile } from "../src/cli.ts";

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
  return processFile(sessionFile, p.sub, p.outRoot);
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

  pi.registerCommand("garden", {
    description: "转换当前 session 到 garden（/garden all = 全量回填 sessions 树）",
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
        for (const job of jobs) {
          try {
            if (processFile(job.src, job.sub, defaultOut).written.length) updated++;
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
}
