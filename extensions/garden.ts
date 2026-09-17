/**
 * garden — pi 扩展。
 *
 * 一、自动转换：会话生命周期内把当前 session .jsonl 转成四级 markdown（l0/l1/l2/l3，
 *   默认只导 l1/l3，PI_GARDEN_LEVELS 配置）。
 *   渲染核心在 ../src（CLI 同源），这里只做事件接线：
 *     session_start    → 补漏（crash / kill 后恢复）
 *     agent_settled    → live 转换（防抖，默认 60s，PI_GARDEN_LIVE_INTERVAL_S 调整，0 关闭）
 *     session_compact  → compaction 章节边界
 *     session_shutdown → 终态保证（quit / new / resume / fork / reload 都会触发）
 *     session_info_changed → metadata 变更（/name 改名），更新文件名 slug
 *   增量判断（mtime + GARDEN_VERSION）在 processFile 内，重复触发几乎零成本。
 *
 * 二、命令：
 *   /garden            → 快速 session 选择器（等位 /resume：fork 树/搜索/删除/重命名/
 *                        新建子会话/子树复制到剪贴板/Ctrl+G 反向同步人工编辑的
 *                        index.md：换父 + to-delete + to-archive，见 src/reverse-sync.ts）。
 *                        数据源 = garden md 产物（不再读 jsonl）；自绘组件零 realpathSync，
 *                        drvfs 上 <3s 就绪（内建组件因 canonicalizePath 卡 ~22s，见
 *                        extensions/garden-selector.ts 头注）
 *   /gardener-output   → 转换当前 session（all = 全量回填 sessions 树；
 *                        index = 重建当前项目目录的 index.md）
 *   /gardener-open [lN]→ 默认浏览器打开当前 session 的 garden md（默认最高存在级别；
 *                        index = 重建并打开当前项目目录的 index.md）
 *
 * 配置（env）：
 *   PI_GARDEN=0                     完全停用本扩展
 *   PI_GARDEN_LEVELS=l1,l3          导出级别（逗号分隔，子集 l0/l1/l2/l3；默认 l1,l3。
 *                                   l0 与源 jsonl 冗余、l2 语料与 l3 重叠，按需再导）
 *   PI_GARDEN_LIVE_INTERVAL_S=60    live 转换最小间隔（秒，可小数）；0 = 关闭 live 触发
 *   PI_GARDEN_OPEN_CMD              自定义打开命令（空格切分；{file} 占位，缺省追加为末参）
 *   PI_GARDEN_SELECTOR_FULLTEXT=1   /garden 选择器用 garden md 正文回填全文搜索语料；
 *                                   0 = 关闭（退回只搜 id/name/cwd）
 *   PI_GARDEN_SELECTOR=builtin      /garden 退回 pi 官方 SessionSelectorComponent（对比/排查用；
 *                                   drvfs 上会卡，正常不要设）
 *
 * 注意：factory 只在会话加载时运行；不在此处起 timer / watcher（pi 扩展约束）。
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { avoidForeignBase, collectJobs, convertGroup, DEFAULT_LEVELS, parseLevels, pathsForFile, prepareGroup, processFile, type LevelName } from "../src/cli.ts";
import { GARDEN_LEVELS, isGardenLevel, openFile, pickHighestLevelFile, type GardenLevel } from "../src/open.ts";
import { generateDirIndex, INDEX_FILE_NAME } from "../src/index-page.ts";
import {
  archiveSessionFile,
  parseIndexRows,
  planPreview,
  planReverseSync,
  rewriteSessionParent,
  type ReverseSyncPlan,
} from "../src/reverse-sync.ts";
import { gardenDirForSessionDir, gardenRootForSessionDir, listAllSessions, listProjectSessions } from "../src/session-list.ts";
import { copyToClipboard } from "./garden-clipboard.ts";
import { deleteGardenOutputs, deleteSessionFile } from "./garden-files.ts";
import { GardenSelectorComponent } from "./garden-selector.ts";

export interface GardenConfig {
  enabled: boolean;
  /** live 触发最小间隔（ms）；0 = 关闭 */
  liveIntervalMs: number;
  /** /garden 选择器是否用 garden md 正文作全文搜索语料（默认开） */
  selectorFullText: boolean;
  /** 导出级别子集（默认 l1,l3） */
  levels: readonly LevelName[];
}

export function readConfig(env: NodeJS.ProcessEnv): GardenConfig {
  const off = (env.PI_GARDEN ?? "").trim() === "0";
  let liveIntervalMs = 60_000;
  const raw = (env.PI_GARDEN_LIVE_INTERVAL_S ?? "").trim();
  if (raw !== "") {
    const n = Number(raw);
    liveIntervalMs = Number.isFinite(n) && n > 0 ? n * 1000 : 0;
  }
  const selectorFullText = (env.PI_GARDEN_SELECTOR_FULLTEXT ?? "").trim() !== "0";
  const levels = parseLevels(env.PI_GARDEN_LEVELS) ?? DEFAULT_LEVELS;
  return { enabled: !off, liveIntervalMs, selectorFullText, levels };
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

/** 转换单个 session 文件；非常规布局或文件不存在返回 null。base = 输出文件名主体（重命名后选择器同步用） */
export function convertSessionFile(sessionFile: string, levels: readonly LevelName[] = DEFAULT_LEVELS): { written: string[]; skipped: string[]; base: string } | null {
  const p = gardenPathsFor(sessionFile);
  if (!p || !existsSync(sessionFile)) return null;
  const outDir = path.join(p.outRoot, p.sub);
  const prepared = prepareGroup([{ src: sessionFile, sub: p.sub }], () => {});
  if (prepared.length === 0) return null;
  // 单 session 组的编号永远从当日 001 起（编号是组内全局属性，live 路径看不到兄弟），
  // 与同 slug 的兄弟文件撞车会**覆盖别人的 md**（2026-09-15 Ctrl+N 后 node11 被顶掉实例）
  // → 撞车递增避让，永不覆盖别的 session；序号短暂不准由下次组转换（all / CLI）归位
  const one = { ...prepared[0], base: avoidForeignBase(outDir, prepared[0].base, prepared[0].id) };
  return { ...processFile(one, outDir, levels), base: one.base };
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
      const res = convertSessionFile(file, cfg.levels);
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

  pi.on("session_info_changed", async (_event, ctx) => {
    convertCurrent(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!cfg.liveIntervalMs) return;
    if (Date.now() - lastConvertAt < cfg.liveIntervalMs) return;
    convertCurrent(ctx);
  });

  pi.registerCommand("gardener-output", {
    description: "转换当前 session 到 garden（all = 全量回填 sessions 树；index = 重建当前目录 index.md）",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "index") {
        await rebuildCurrentDirIndex(ctx);
        return;
      }
      if (arg === "all") {
        const file = ctx.sessionManager.getSessionFile();
        const sessionsDir = file ? path.dirname(path.dirname(file)) : path.join(process.env.HOME ?? "", ".pi", "agent", "sessions");
        if (!existsSync(sessionsDir)) {
          notify(ctx, `garden: sessions 目录不存在: ${sessionsDir}`, "warning");
          return;
        }
        const { jobs, defaultOut } = collectJobs(sessionsDir);
        // 编号是同目录内的全局属性 → 按子目录分组走 convertGroup（组内编号计划 + 旧命名清理），
        // 与 CLI 目录模式同路径；曾有的两个 bug：全量 prepareGroup 跨子目录编号错乱、
        // 不清旧命名文件（编号撞车残留永远留着）
        const groups = new Map<string, typeof jobs>();
        for (const job of jobs) {
          const list = groups.get(job.sub) ?? [];
          list.push(job);
          groups.set(job.sub, list);
        }
        let updated = 0;
        let failed = 0;
        let removed = 0;
        const dirtySubs = new Set<string>();
        for (const [sub, groupJobs] of groups) {
          const { results, removed: r } = convertGroup(groupJobs, path.join(defaultOut, sub), cfg.levels, () => {
            failed++;
          });
          removed += r;
          if (r > 0 || results.some((x) => x.written.length)) dirtySubs.add(sub);
          for (const { written, error } of results) {
            if (error) failed++;
            else if (written.length) updated++;
          }
        }
        // 索引收尾：有变化的目录重建 index.md（与 CLI 目录模式同一语义）
        let indexCount = 0;
        for (const sub of dirtySubs) {
          try {
            if (await generateDirIndex(path.join(defaultOut, sub))) indexCount++;
          } catch { /* 索引失败不影响转换结果 */ }
        }
        notify(
          ctx,
          `garden all: ${jobs.length} 个 session，${updated} 更新${removed ? `，清理 ${removed} 个旧文件` : ""}${indexCount ? `，index × ${indexCount}` : ""}${failed ? `，${failed} 失败` : ""} → ${defaultOut}`,
          failed ? "warning" : "info",
        );
        return;
      }
      const msg = convertCurrent(ctx);
      notify(ctx, msg ?? "garden: 当前会话无可转换的 session 文件", "info");
    },
  });

  /** 重建当前 session 所属 garden 项目目录的 index.md 并 notify；返回生成结果（无产物 → null） */
  async function rebuildCurrentDirIndex(ctx: ExtensionContext) {
    const dir = gardenDirForSessionDir(ctx.sessionManager.getSessionDir());
    const r = await generateDirIndex(dir);
    notify(
      ctx,
      r ? `garden index: ${r.sessions} 条对话 · ${r.roots} 棵树 → ${r.file}${r.changed ? "" : "（已是最新）"}` : `garden index: ${dir} 暂无会话产物`,
      r ? "info" : "warning",
    );
    return r;
  }

  pi.registerCommand("gardener-open", {
    description: `默认浏览器打开当前 session 的 garden md（默认最高存在级别；可用 ${GARDEN_LEVELS.join("/")} 指定；index = 重建并打开目录索引）`,
    handler: async (args, ctx) => {
      const levelArg = args.trim();
      if (levelArg === "index") {
        const r = await rebuildCurrentDirIndex(ctx);
        if (!r) return;
        const o = await openFile(r.file, process.env);
        notify(ctx, o.ok ? `gardener-open: 已打开 ${INDEX_FILE_NAME}` : `gardener-open 失败: ${o.detail}`, o.ok ? "info" : "warning");
        return;
      }
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
      if (!target) {
        // 无产物时先转换再取：指定级别 → 不在默认导出集也只生成该级别；未指定 → 按配置转换
        if (level) convertSessionFile(file, [level]);
        else convertCurrent(ctx);
        target = pickHighestLevelFile(mdDir, computeBase(), level);
      }
      if (!target) {
        notify(ctx, `gardener-open: 无 ${levelArg || "任何级别"} 的输出文件`, "warning");
        return;
      }
      const r = await openFile(target, process.env);
      notify(ctx, r.ok ? `gardener-open: 已打开 ${path.basename(target)}` : `gardener-open 失败: ${r.detail}`, r.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("garden", {
    description: "快速 session 选择器（等位 /resume；数据源 = garden md 产物，慢盘友好）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(ctx, "garden: 选择器需要 TUI/RPC 模式", "warning");
        return;
      }
      const sessionDir = ctx.sessionManager.getSessionDir();
      const gardenDir = gardenDirForSessionDir(sessionDir);
      const gardenRoot = gardenRootForSessionDir(sessionDir);
      const currentFile = ctx.sessionManager.getSessionFile();
      const loadCurrent = (onProgress: (loaded: number, total: number) => void) =>
        listProjectSessions(gardenDir, { onProgress, fullText: cfg.selectorFullText });
      const loadAll = (onProgress: (loaded: number, total: number) => void) =>
        listAllSessions(gardenRoot, { onProgress, fullText: cfg.selectorFullText });

      let picked: string | null;
      // Ctrl+G 反向同步：prepare/apply 分离——prepare 对账并给确认条汇总，
      // plan 暂存闭包，选择器 Enter 确认后 apply 消费（单次使用）
      let pendingPlan: ReverseSyncPlan | null = null;
      const reverseSync = {
        prepare: async () => {
          pendingPlan = null;
          const indexFile = path.join(gardenDir, INDEX_FILE_NAME);
          if (!existsSync(indexFile)) {
            return { ok: false as const, error: "无 index.md，请先 /gardener-output index 生成" };
          }
          let rows;
          try {
            rows = parseIndexRows(readFileSync(indexFile, "utf-8"));
          } catch (e) {
            return { ok: false as const, error: `index.md 读取失败: ${(e as Error).message}` };
          }
          const items = await listProjectSessions(gardenDir, { fullText: false });
          const r = planReverseSync(rows, items, { protectedPaths: new Set(currentFile ? [currentFile] : []) });
          if (!r.ok) return { ok: false as const, error: r.error };
          pendingPlan = r.plan;
          return { ok: true as const, preview: planPreview(r.plan) };
        },
        apply: async () => {
          const plan = pendingPlan;
          pendingPlan = null;
          if (!plan) return { ok: false as const, error: "没有待执行的同步计划，请重新按 Ctrl+G" };
          const errors: string[] = [];
          let deleted = 0;
          let archived = 0;
          let reparented = 0;
          for (const item of plan.deletes) {
            const r = await deleteSessionFile(item.path);
            if (r.ok) {
              await deleteGardenOutputs(item);
              deleted++;
            } else {
              errors.push(`删除 ${item.mdBase}: ${r.error ?? "未知错误"}`);
            }
          }
          for (const op of plan.archives) {
            const r = archiveSessionFile(op.item.path, op.item.id, op.treePath);
            if (r.ok) {
              await deleteGardenOutputs(op.item);
              archived++;
            } else {
              errors.push(`归档 ${op.item.mdBase}: ${r.error ?? "未知错误"}`);
            }
          }
          for (const op of plan.reparents) {
            const r = rewriteSessionParent(op.item.path, op.item.id, op.newParentPath);
            if (!r.ok) {
              errors.push(`换父 ${op.item.mdBase}: ${r.error ?? "未知错误"}`);
              continue;
            }
            reparented++;
            // md frontmatter 的 parent_session 是 index/选择器的树数据源，必须立即重转，
            // 否则下次重建 index 又显示旧树（jsonl 重写后 mtime 变新 → isUpToDate 判过期）
            try {
              convertSessionFile(op.item.path, cfg.levels);
            } catch (e) {
              errors.push(`重转 ${op.item.mdBase}: ${(e as Error).message}`);
            }
          }
          // 收尾重建索引（固化新树、消费掉标记）；全删光时无内容可生成 → 移除索引
          let indexNote = "";
          try {
            const remaining = await listProjectSessions(gardenDir, { fullText: false });
            if (remaining.length === 0) {
              unlinkSync(path.join(gardenDir, INDEX_FILE_NAME));
              indexNote = "，index.md 已清空移除";
            } else {
              await generateDirIndex(gardenDir);
              indexNote = "，index 已重建";
            }
          } catch (e) {
            errors.push(`index 重建: ${(e as Error).message}`);
          }
          const message = `反向同步: ${reparented} 换父 · ${deleted} 删除 · ${archived} 归档${indexNote}`;
          if (errors.length) {
            return { ok: false as const, error: `${message}；${errors.length} 项失败: ${errors[0]}${errors.length > 1 ? " 等" : ""}` };
          }
          return { ok: true as const, message };
        },
      };
      if ((process.env.PI_GARDEN_SELECTOR ?? "").trim() === "builtin") {
        // 回退：pi 官方组件（内部 canonicalizePath 在 drvfs 上会卡 ~22s，仅用于对比/排查）。
        // 动态 import：仅在此分支才加载 pi 包（保持本文件可被零依赖测试）
        const { SessionSelectorComponent } = (await import("@earendil-works/pi-coding-agent")) as any;
        picked = await ctx.ui.custom<string | null>(
          (tui, _theme, keybindings, done) =>
            new SessionSelectorComponent(
              loadCurrent,
              loadAll,
              (p: string) => done(p),
              () => done(null),
              () => done(null),
              () => tui.requestRender(),
              { keybindings },
              currentFile ?? undefined,
            ),
        );
      } else {
        picked = await ctx.ui.custom<string | null>(
          (tui, theme, keybindings, done) =>
            new GardenSelectorComponent({
              theme,
              keybindings,
              requestRender: () => tui.requestRender(),
              getTerminalHeight: () => (tui as any).getTerminalHeight?.() ?? process.stdout.rows ?? 24,
              currentFilePath: currentFile ?? undefined,
              loadCurrent,
              loadAll,
              onSelect: (p) => done(p),
              onCancel: () => done(null),
              onNewChild: (item) => {
                done(null);
                void ctx.newSession({ parentSession: item.path });
              },
              copyToClipboard,
              reverseSync,
              renameSession: async (item, name) => {
                // 与内建 /resume 同一实现路径；随后立即重转，让 md frontmatter/文件名同步新名
                const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as any;
                SessionManager.open(item.path).appendSessionInfo(name);
                return convertSessionFile(item.path)?.base;
              },
              deleteSession: async (item) => {
                const r = await deleteSessionFile(item.path);
                if (r.ok) await deleteGardenOutputs(item); // md 是选择器数据源，必须同步清理
                return r;
              },
            }),
        );
      }
      if (!picked) return;
      if (!existsSync(picked)) {
        // 列表期不做存在性校验（315 次 syscall ≈ 7s），选中这一次才查
        notify(ctx, `garden: 源 jsonl 已不存在（md 归档仍在）: ${path.basename(picked)}`, "warning");
        return;
      }
      try {
        await ctx.switchSession(picked);
      } catch (e) {
        notify(ctx, `garden: 切换 session 失败: ${(e as Error).message}`, "warning");
      }
    },
  });
}
