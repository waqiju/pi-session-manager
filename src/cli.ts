#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSessionFile } from "./parser.ts";
import { renderL0 } from "./render/l0.ts";
import { renderL1 } from "./render/l1.ts";
import { renderL2 } from "./render/l2.ts";
import { GARDEN_VERSION } from "./render/shared.ts";
import type { Entry, SessionHeader } from "./types.ts";

const USAGE = `garden — 把 pi sessions (.jsonl) 转成三级 markdown (l0/l1/l2)

用法:
  garden                     转换 ~/.pi/agent/sessions → ~/.pi/agent/garden
  garden <sessions目录>      输出到其同级 garden/
  garden <xxx.jsonl>         单文件模式
  garden ... -o <输出目录>   自定义输出目录

增量: 源文件 mtime 比输出新才重新生成。
`;

const LEVELS: { name: "l0" | "l1" | "l2"; render: (h: SessionHeader | null, e: Entry[], o: { sourceName?: string }) => string }[] = [
  { name: "l0", render: renderL0 },
  { name: "l1", render: renderL1 },
  { name: "l2", render: renderL2 },
];

interface Job {
  src: string;
  /** sessions 下的子目录名（--cwd-- 形式），用于镜像输出结构 */
  sub: string;
}

export function collectJobs(input: string): { jobs: Job[]; defaultOut: string } {
  const st = statSync(input);
  if (st.isFile()) {
    // .../sessions/<sub>/<file>.jsonl → garden 与 sessions 同级
    const sub = path.basename(path.dirname(input));
    const sessionsRoot = path.dirname(path.dirname(input));
    return { jobs: [{ src: input, sub }], defaultOut: path.join(path.dirname(sessionsRoot), "garden") };
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
  return { jobs, defaultOut: path.join(path.dirname(input), "garden") };
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

export function processFile(src: string, sub: string, outRoot: string): { written: string[]; skipped: string[] } {
  const parsed = parseSessionFile(src);
  const base = path.basename(src).replace(/\.jsonl$/, "");
  const srcMtime = statSync(src).mtimeMs;
  const written: string[] = [];
  const skipped: string[] = [];
  for (const { name, render } of LEVELS) {
    const outDir = path.join(outRoot, sub);
    const outPath = path.join(outDir, `${base}.${name}.md`);
    if (isUpToDate(outPath, srcMtime)) {
      skipped.push(name);
      continue;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, render(parsed.header, parsed.entries, { sourceName: path.basename(src) }));
    written.push(name);
  }
  return { written, skipped };
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" } },
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
  const { jobs, defaultOut } = collectJobs(input);
  const outRoot = path.resolve(values.output ?? defaultOut);
  console.log(`garden: ${jobs.length} 个 session → ${outRoot}`);
  let updated = 0;
  let fresh = 0;
  let failed = 0;
  for (const job of jobs) {
    const rel = path.join(job.sub, path.basename(job.src));
    try {
      const { written } = processFile(job.src, job.sub, outRoot);
      if (written.length) {
        updated++;
        console.log(`  ✓ ${rel} → ${written.map((l) => `.${l}.md`).join(" ")}`);
      } else {
        fresh++;
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${rel}: ${(e as Error).message}`);
    }
  }
  console.log(`完成: ${updated} 更新, ${fresh} 已是最新${failed ? `, ${failed} 失败` : ""}`);
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
