#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { generateDirIndex, INDEX_FILE_NAME } from "./index-page.ts";
import { extractNamingInfo, planBaseNames } from "./naming.ts";
import { parseSessionFile } from "./parser.ts";
import type { ParsedSession } from "./parser.ts";
import { renderL0 } from "./render/l0.ts";
import { renderL1 } from "./render/l1.ts";
import { renderL2 } from "./render/l2.ts";
import { renderL3 } from "./render/l3.ts";
import { GARDEN_VERSION } from "./render/shared.ts";
import type { Entry, SessionHeader } from "./types.ts";

const USAGE = `garden — 把 pi sessions (.jsonl) 转成四级 markdown (l0/l1/l2/l3)

用法:
  garden                     转换 ~/.pi/agent/sessions → ~/.pi/agent/garden
  garden <sessions目录>      输出到其同级 garden/
  garden <xxx.jsonl>         单文件模式（编号仍参考同目录全部 session）
  garden ... -o <输出目录>   自定义输出目录
  garden ... --levels l0,l1  指定导出级别（默认 l1,l3；也可用 env PI_GARDEN_LEVELS，flag 优先）
  garden --sync [path]       同步：删除已删 session 的孤儿产物 + 多余级别，然后增量转换
  garden --sync --dry-run    同步演练：只打印将删除的文件，不实际操作
  garden --index [path]      只重建各 garden 项目目录的 index.md（输入解析同转换，不做转换）

命名: <本地日期>-<序号>-<slug>.<level>.md（slug = 会话名，无则 untitled）
增量: 源文件 mtime 比输出新才重新生成。
清理: 改名/重编号后，按 frontmatter session_id 匹配删除同 session 的旧文件。
`;

export type LevelName = "l0" | "l1" | "l2" | "l3";

const LEVELS: { name: LevelName; render: (h: SessionHeader | null, e: Entry[], o: { sourceName?: string }) => string }[] = [
  { name: "l0", render: renderL0 },
  { name: "l1", render: renderL1 },
  { name: "l2", render: renderL2 },
  { name: "l3", render: renderL3 },
];

/** 默认导出级别：l1（阅读主力）+ l3（问答视图）。l0 与源 jsonl 冗余、l2 语料与 l3 重叠，按需再导 */
export const DEFAULT_LEVELS: readonly LevelName[] = ["l1", "l3"];

/** 解析 "l1,l3" 形式的级别列表（逗号分隔、大小写不敏感、去重、保序）；空或全无有效项 → undefined（调用方回退默认） */
export function parseLevels(raw: string | undefined): LevelName[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const valid = new Set<string>(LEVELS.map((l) => l.name));
  const levels = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => valid.has(s)))] as LevelName[];
  return levels.length ? levels : undefined;
}

interface Job {
  src: string;
  /** sessions 下的子目录名（--cwd-- 形式），用于镜像输出结构 */
  sub: string;
}

/** 单文件路径推导：<root>/sessions/<sub>/<file>.jsonl → { sub, outRoot: <root>/garden }（纯推导，不校验布局） */
export function pathsForFile(src: string): { sub: string; outRoot: string } {
  const sub = path.basename(path.dirname(src));
  const sessionsRoot = path.dirname(path.dirname(src));
  return { sub, outRoot: path.join(path.dirname(sessionsRoot), "garden") };
}

export function collectJobs(input: string): { jobs: Job[]; target: string | null; defaultOut: string } {
  const st = statSync(input);
  if (st.isFile()) {
    // .../sessions/<sub>/<file>.jsonl → garden 与 sessions 同级
    // 单文件模式：编号依赖同目录全部 session 的排序，兄弟 .jsonl 纳入编号计划（但不写输出）
    const { sub, outRoot } = pathsForFile(input);
    const dir = path.dirname(input);
    const jobs: Job[] = [];
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".jsonl")) jobs.push({ src: path.join(dir, f), sub });
    }
    jobs.sort((a, b) => a.src.localeCompare(b.src));
    return { jobs, target: input, defaultOut: outRoot };
  }
  const jobs: Job[] = [];
  for (const d of readdirSync(input, { withFileTypes: true })) {
    if (d.isDirectory()) {
      const subDir = path.join(input, d.name);
      for (const f of readdirSync(subDir)) {
        if (f.endsWith(".jsonl")) jobs.push({ src: path.join(subDir, f), sub: d.name });
      }
    } else if (d.name.endsWith(".jsonl")) {
      jobs.push({ src: path.join(input, d.name), sub: "" });
    }
  }
  jobs.sort((a, b) => a.src.localeCompare(b.src));
  return { jobs, target: null, defaultOut: path.join(path.dirname(input), "garden") };
}

/**
 * 增量判断：mtime 较新、含当前版本标记、且**归属本 session** 才算已是最新（逻辑变更后自动全量刷新）。
 * 归属校验防编号撞车后遗症：live 转换曾把别 session 的内容写进本 base（单 session 组永远 001，
 * 见 extensions/garden.ts convertSessionFile），不查 session_id 会把别人的文件当“最新”而跳过，
 * 被撞的 session 永远恢复不了（2026-09-15 实例）。
 */
export function isUpToDate(outPath: string, srcMtime: number, sessionId?: string): boolean {
  if (!existsSync(outPath)) return false;
  if (statSync(outPath).mtimeMs < srcMtime) return false;
  const head = readHead(outPath);
  if (sessionId !== undefined && !head.includes(`session_id: ${JSON.stringify(sessionId)}`)) return false;
  return head.includes(`version: ${JSON.stringify(GARDEN_VERSION)}`);
}

export interface Prepared {
  job: Job;
  parsed: ParsedSession;
  /** session id：旧命名文件清理的匹配依据 */
  id: string;
  /** 目标文件名（不含 .<level>.md 后缀） */
  base: string;
  srcMtime: number;
}

/** 解析同组全部 session 并计算命名计划（编号是组内全局属性）；单个失败跳过并上报 */
export function prepareGroup(jobs: Job[], onError: (job: Job, err: Error) => void): Prepared[] {
  const ok: { job: Job; parsed: ParsedSession; srcMtime: number }[] = [];
  for (const job of jobs) {
    try {
      ok.push({ job, parsed: parseSessionFile(job.src), srcMtime: statSync(job.src).mtimeMs });
    } catch (e) {
      onError(job, e as Error);
    }
  }
  const infos = ok.map((p) => extractNamingInfo(p.job.src, p.parsed.header, p.parsed.entries, p.srcMtime));
  const bases = planBaseNames(infos);
  return ok.map((p, i) => ({ ...p, id: infos[i].id, base: bases.get(p.job.src)! }));
}

/** 输出文件名后缀：.l0.md / .l1.md / ...（前瞻任意 lN，级别扩展不用改这里） */
const OUT_FILE_RE = /\.l\d+\.md$/;

/** 读文件前 2KB（frontmatter 的 session_id 在开头几行，不读全文件） */
function readHead(filePath: string): string {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.alloc(2048);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return "";
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** 扫描输出目录，按 frontmatter 的 session_id 索引已有输出文件（key = session_id 的 JSON 字面量） */
export function indexOutputsBySessionId(outDir: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  let dirents: Dirent[];
  try {
    dirents = readdirSync(outDir, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const d of dirents) {
    if (!d.isFile() || !OUT_FILE_RE.test(d.name)) continue;
    const m = readHead(path.join(outDir, d.name)).match(/^session_id: ("(?:[^"\\]|\\.)*")$/m);
    if (!m) continue;
    const list = index.get(m[1]) ?? [];
    list.push(d.name);
    index.set(m[1], list);
  }
  return index;
}

/**
 * 删除本会话的旧命名文件（改名/重编号/命名方案迁移产生的孤儿）。
 * 只认 frontmatter uuid：其他 session 的文件 uuid 不匹配，误删不了；
 * 源 jsonl 已删除的孤儿输出不在任何 session 的匹配范围内，会保留（归档语义）。
 * 删除前**重读文件头复核当前归属**：index 是循环前快照，循环内编号交接（别的 session
 * 被重命名/重编号到这个 base）可能已改写文件内容，快照过期会误删别人的新文件。
 */
export function removeStaleOutputs(index: Map<string, string[]>, outDir: string, sessionId: string, keepBase: string): number {
  const key = JSON.stringify(sessionId);
  const files = index.get(key);
  if (!files) return 0;
  index.delete(key); // 每个 session 只清理一次
  let removed = 0;
  for (const f of files) {
    if (f.replace(OUT_FILE_RE, "") === keepBase) continue;
    // 复核：读不出 head 或当前归属已变 → 不删
    const head = readHead(path.join(outDir, f));
    if (!head.includes(`session_id: ${key}`)) continue;
    try {
      unlinkSync(path.join(outDir, f));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/** --sync 清理：删除已删 session 的孤儿文件 + 不在允许级别集中的多余级别文件。dryRun 时只打印不删 */
export function syncCleanup(
  index: Map<string, string[]>,
  validIds: Set<string>,
  allowedLevels: Set<string>,
  gardenRoot: string,
  dryRun: boolean,
): number {
  let count = 0;
  for (const [key, files] of index) {
    const sessionId = JSON.parse(key) as string;
    const isOrphan = !validIds.has(sessionId);
    for (const rel of files) {
      const m = rel.match(/\.l(\d+)\.md$/);
      if (!isOrphan && m && allowedLevels.has(`l${m[1]}`)) continue;
      const label = isOrphan ? "orphan" : "stale level";
      console.log(`  ${dryRun ? "(dry-run) " : ""}删除 ${label}: ${rel}`);
      if (!dryRun) {
        try { unlinkSync(path.join(gardenRoot, rel)); } catch { /* ignore */ }
      }
      count++;
    }
  }
  return count;
}

/** --sync 流程：扫描索引 → 清理孤儿 & 多余级别 → 增量转换 */
export function runSync(
  input: string,
  outRoot: string,
  levels: readonly LevelName[],
  dryRun: boolean,
): { updated: number; fresh: number; failed: number; removed: number } {
  const { jobs } = collectJobs(input);
  const levelSet = new Set<string>(levels);

  // 1. 收集所有 session_id + 正常增量转换
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = groups.get(job.sub) ?? [];
    list.push(job);
    groups.set(job.sub, list);
  }
  const validIds = new Set<string>();
  const fullIndex = new Map<string, string[]>(); // syncCleanup 用：合并所有子目录的索引副本
  let updated = 0, fresh = 0, failed = 0;
  for (const [sub, groupJobs] of groups) {
    const outDir = path.join(outRoot, sub);
    const staleIndex = indexOutputsBySessionId(outDir); // syncCleanup 孤儿判定基线（转换前快照，convertGroup 不动它）
    const { results, prepared } = convertGroup(groupJobs, outDir, levels, (job) => {
      failed++;
      console.error(`  ✗ ${path.join(sub, path.basename(job.src))}: 读取/解析失败`);
    });
    for (const p of prepared) validIds.add(p.id);
    for (const { p, written, error } of results) {
      const rel = path.join(sub, path.basename(p.job.src));
      if (error) {
        failed++;
        console.error(`  ✗ ${rel}: ${error.message}`);
      } else if (written.length) {
        updated++;
        console.log(`  ✓ ${rel} → ${p.base} (${written.map((l) => `.${l}.md`).join(" ")})`);
      } else {
        fresh++;
      }
    }
    for (const [k, v] of staleIndex) {
      const list = fullIndex.get(k) ?? [];
      for (const f of v) list.push(path.join(sub, f));
      fullIndex.set(k, list);
    }
  }

  // 2. 扫描 garden 全目录 → 清理孤儿 & 多余级别
  let removed = 0;
  if (existsSync(outRoot)) {
    removed = syncCleanup(fullIndex, validIds, levelSet, outRoot, dryRun);
    if (!removed) console.log("garden sync: garden 已是同步状态");
  } else {
    console.log("garden sync: garden 目录不存在，仅增量转换");
  }

  return { updated, fresh, failed, removed };
}

export function processFile(p: Prepared, outDir: string, levels: readonly LevelName[] = DEFAULT_LEVELS): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const { name, render } of LEVELS) {
    if (!levels.includes(name)) continue;
    const outPath = path.join(outDir, `${p.base}.${name}.md`);
    if (isUpToDate(outPath, p.srcMtime, p.id)) {
      skipped.push(name);
      continue;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, render(p.parsed.header, p.parsed.entries, { sourceName: path.basename(p.job.src) }));
    written.push(name);
  }
  return { written, skipped };
}

/** base 文件名结构：<日期>-<序号>-<slug>（避让递增序号用） */
const BASE_SEQ_RE = /^(\d{4}-\d{2}-\d{2})-(\d{3})-(.+)$/;

/** outDir 内该 base 的任一级别文件是否被别的 session 占用（读不出 session_id 的保守视为占用） */
function baseTakenByOther(outDir: string, base: string, sessionId: string): boolean {
  let names: string[];
  try {
    names = readdirSync(outDir);
  } catch {
    return false; // 目录不存在 = 无占用
  }
  const self = JSON.stringify(sessionId);
  for (const name of names) {
    if (!name.startsWith(`${base}.l`) || !OUT_FILE_RE.test(name)) continue;
    const m = readHead(path.join(outDir, name)).match(/^session_id: ("(?:[^"\\]|\\.)*")$/m);
    if (m?.[1] !== self) return true;
  }
  return false;
}

/**
 * live 转换（单 session 组）的编号避让：单 session 组算出的序号永远是当日 001，
 * 直接写会覆盖同日已有的同 slug 文件（2026-09-15 Ctrl+N 后 node11 被 node-new 顶掉实例）。
 * 这里撞车时递增序号直到空位/本 session 已占用——**永不覆盖别人的文件**，防毁数据优先；
 * 序号可能与时间序短暂不符，下次组转换（all / CLI）会归位。
 * 全量路径不用它：那里 planBaseNames 看到全组，编号本来就准，冲突文件应直接重写归位。
 */
export function avoidForeignBase(outDir: string, base: string, sessionId: string): string {
  const m = base.match(BASE_SEQ_RE);
  if (!m) return base;
  let n = Number(m[2]);
  let candidate = base;
  while (baseTakenByOther(outDir, candidate, sessionId)) {
    n++;
    candidate = `${m[1]}-${String(n).padStart(3, "0")}-${m[3]}`;
  }
  return candidate;
}

/** 目录内是否有会话产物（*.lN.md）；--index 的顶层直放布局判定用 */
function dirHasMdFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => OUT_FILE_RE.test(f));
  } catch {
    return false;
  }
}

/** 现有 garden 项目目录清单：outRoot 下非隐藏子目录 + outRoot 自身（顶层直放 md 的非标准布局） */
export function existingGardenDirs(outRoot: string): string[] {
  const dirs: string[] = [];
  let dirents: Dirent[];
  try {
    dirents = readdirSync(outRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const d of dirents) {
    if (d.isDirectory() && !d.name.startsWith(".")) dirs.push(path.join(outRoot, d.name));
  }
  if (dirHasMdFiles(outRoot)) dirs.push(outRoot);
  return dirs;
}

/** 重建各目录的 index.md 并打印；无会话产物的目录静默跳过。返回实际生成数 */
async function refreshIndexes(dirs: string[], outRoot: string): Promise<number> {
  let done = 0;
  for (const dir of dirs) {
    let r;
    try {
      r = await generateDirIndex(dir);
    } catch (e) {
      console.error(`  ✗ index.md 生成失败 ${dir}: ${(e as Error).message}`);
      continue;
    }
    if (!r) continue;
    done++;
    const rel = path.relative(outRoot, dir);
    console.log(`  ✓ ${rel ? `${rel}/` : ""}index.md（${r.sessions} 条对话 · ${r.roots} 棵树${r.changed ? "" : "，已是最新"}）`);
  }
  return done;
}

/** convertGroup 单条结果 */
export interface ConvertGroupItem {
  p: Prepared;
  written: string[];
  error?: Error;
}

/**
 * 同组（同一输出目录）统一转换：组内编号计划（编号是组内全局属性，必须整组 planBaseNames）
 * + 旧命名清理（removeStaleOutputs）+ 增量写。CLI 目录模式 / --sync / 扩展 /gardener-output all
 * 共用，保证三条路径的编号与清理语义一致。单文件模式传 include 过滤（兄弟只参与编号不写输出）。
 */
export function convertGroup(
  groupJobs: Job[],
  outDir: string,
  levels: readonly LevelName[],
  onError: (job: Job, err: Error) => void,
  include?: (p: Prepared) => boolean,
): { results: ConvertGroupItem[]; removed: number; prepared: Prepared[] } {
  const prepared = prepareGroup(groupJobs, onError);
  const index = indexOutputsBySessionId(outDir);
  const results: ConvertGroupItem[] = [];
  let removed = 0;
  for (const p of prepared) {
    if (include && !include(p)) continue;
    try {
      removed += removeStaleOutputs(index, outDir, p.id, p.base);
      const { written } = processFile(p, outDir, levels);
      results.push({ p, written });
    } catch (e) {
      results.push({ p, written: [], error: e as Error });
    }
  }
  return { results, removed, prepared };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { output: { type: "string", short: "o" }, levels: { type: "string" }, sync: { type: "boolean" }, index: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const input = path.resolve(positionals[0] ?? path.join(homedir(), ".pi", "agent", "sessions"));
  if (!existsSync(input)) {
    console.error(`路径不存在: ${input}`);
    process.exit(1);
  }
  const { jobs, target, defaultOut } = collectJobs(input);
  const outRoot = path.resolve(values.output ?? defaultOut);
  const levels = parseLevels(values.levels) ?? parseLevels(process.env.PI_GARDEN_LEVELS) ?? DEFAULT_LEVELS;
  const dryRun = !!values["dry-run"];

  if (values.index) {
    if (values.sync) { console.error("--index 与 --sync 不能同用"); process.exit(1); }
    // 索引对象是 garden 侧产物：单文件 → 对应项目目录；目录 → 全部现有项目目录
    const dirs = target ? [path.join(outRoot, path.basename(path.dirname(target)))] : existingGardenDirs(outRoot);
    console.log(`garden --index: ${dirs.length} 个目录 → ${outRoot}`);
    const n = await refreshIndexes(dirs, outRoot);
    console.log(`完成: ${n} 个 index.md${n < dirs.length ? `，${dirs.length - n} 个目录无会话产物` : ""}`);
    return;
  }

  if (values.sync) {
    if (target) { console.error("--sync 不支持单文件模式，请使用目录路径"); process.exit(1); }
    console.log(`garden sync: ${jobs.length} 个 session → ${outRoot}（级别 ${levels.join(",")}）${dryRun ? " (dry-run)" : ""}`);
    const { updated, fresh, failed, removed } = runSync(input, outRoot, levels, dryRun);
    // 同步是全量对账：重建所有现有项目目录的索引（含 jsonl 已删的归档目录；dry-run 不动盘）
    if (!dryRun) await refreshIndexes(existingGardenDirs(outRoot), outRoot);
    console.log(`完成: ${updated} 更新, ${fresh} 已是最新${removed ? `, ${dryRun ? "将删除" : "清理"} ${removed} 个文件` : ""}${failed ? `, ${failed} 失败` : ""}`);
    if (failed) process.exit(1);
    return;
  }

  console.log(`garden: ${target ? 1 : jobs.length} 个 session → ${outRoot}（级别 ${levels.join(",")}）`);

  // 编号是同目录内的全局属性 → 按子目录分组，组内统一解析 + 命名计划
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = groups.get(job.sub) ?? [];
    list.push(job);
    groups.set(job.sub, list);
  }

  let updated = 0;
  let fresh = 0;
  let failed = 0;
  let removed = 0;
  const dirtySubs = new Set<string>(); // 有写入/清理的目录 → 收尾重建 index.md
  for (const [sub, groupJobs] of groups) {
    const outDir = path.join(outRoot, sub);
    const { results, removed: r } = convertGroup(
      groupJobs,
      outDir,
      levels,
      (job) => {
        failed++;
        console.error(`  ✗ ${path.join(sub, path.basename(job.src))}: 读取/解析失败`);
      },
      target ? (p) => p.job.src === target : undefined, // 单文件模式：兄弟只参与编号
    );
    removed += r;
    if (r > 0 || results.some((x) => x.written.length)) dirtySubs.add(sub);
    for (const { p, written, error } of results) {
      const rel = path.join(sub, path.basename(p.job.src));
      if (error) {
        failed++;
        console.error(`  ✗ ${rel}: ${error.message}`);
      } else if (written.length) {
        updated++;
        console.log(`  ✓ ${rel} → ${p.base} (${written.map((l) => `.${l}.md`).join(" ")})`);
      } else {
        fresh++;
      }
    }
  }
  // 索引收尾：有变化的目录重建；缺 index.md 的目录（首次升级/新目录）也补建
  const indexDirs = [...groups.keys()]
    .filter((sub) => dirtySubs.has(sub) || !existsSync(path.join(outRoot, sub, INDEX_FILE_NAME)))
    .map((sub) => path.join(outRoot, sub));
  await refreshIndexes(indexDirs, outRoot);
  console.log(`完成: ${updated} 更新, ${fresh} 已是最新${removed ? `, 清理 ${removed} 个旧文件` : ""}${failed ? `, ${failed} 失败` : ""}`);
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
