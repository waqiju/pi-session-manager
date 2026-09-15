#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
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

/** 增量判断：mtime 较新且含当前版本标记才算已是最新（逻辑变更后自动全量刷新） */
export function isUpToDate(outPath: string, srcMtime: number): boolean {
  if (!existsSync(outPath)) return false;
  if (statSync(outPath).mtimeMs < srcMtime) return false;
  try {
    const head = readFileSync(outPath, "utf8");
    return head.includes(`version: ${JSON.stringify(GARDEN_VERSION)}`);
  } catch {
    return false;
  }
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
 */
export function removeStaleOutputs(index: Map<string, string[]>, outDir: string, sessionId: string, keepBase: string): number {
  const key = JSON.stringify(sessionId);
  const files = index.get(key);
  if (!files) return 0;
  index.delete(key); // 每个 session 只清理一次
  let removed = 0;
  for (const f of files) {
    if (f.replace(OUT_FILE_RE, "") === keepBase) continue;
    try {
      unlinkSync(path.join(outDir, f));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export function processFile(p: Prepared, outDir: string, levels: readonly LevelName[] = DEFAULT_LEVELS): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const { name, render } of LEVELS) {
    if (!levels.includes(name)) continue;
    const outPath = path.join(outDir, `${p.base}.${name}.md`);
    if (isUpToDate(outPath, p.srcMtime)) {
      skipped.push(name);
      continue;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, render(p.parsed.header, p.parsed.entries, { sourceName: path.basename(p.job.src) }));
    written.push(name);
  }
  return { written, skipped };
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { output: { type: "string", short: "o" }, levels: { type: "string" }, help: { type: "boolean", short: "h" } },
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
  for (const [sub, groupJobs] of groups) {
    const outDir = path.join(outRoot, sub);
    const prepared = prepareGroup(groupJobs, (job) => {
      failed++;
      console.error(`  ✗ ${path.join(sub, path.basename(job.src))}: 读取/解析失败`);
    });
    const index = indexOutputsBySessionId(outDir);
    for (const p of prepared) {
      if (target && p.job.src !== target) continue; // 单文件模式：兄弟只参与编号
      const rel = path.join(sub, path.basename(p.job.src));
      try {
        removed += removeStaleOutputs(index, outDir, p.id, p.base);
        const { written } = processFile(p, outDir, levels);
        if (written.length) {
          updated++;
          console.log(`  ✓ ${rel} → ${p.base} (${written.map((l) => `.${l}.md`).join(" ")})`);
        } else {
          fresh++;
        }
      } catch (e) {
        failed++;
        console.error(`  ✗ ${rel}: ${(e as Error).message}`);
      }
    }
  }
  console.log(`完成: ${updated} 更新, ${fresh} 已是最新${removed ? `, 清理 ${removed} 个旧文件` : ""}${failed ? `, ${failed} 失败` : ""}`);
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
