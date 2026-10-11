import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseGardenFrontmatter } from "./session-list.ts";

/** Detection only: never persisted as a project identity. */
export function stripProjectPrefix(cwd: string): { key: string; rank: number; platform: string } | null {
  const p = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  let m: RegExpExecArray | null;
  let rank: number, platform: string, tail: string;
  if ((m = /^\/mnt\/[a-zA-Z]\/(.+)$/.exec(p))) { rank = 0; platform = "WSL"; tail = m[1]; }
  else if ((m = /^[a-zA-Z]:\/(.+)$/.exec(p))) { rank = 1; platform = "Windows"; tail = m[1]; }
  else if ((m = /^\/Users\/[^/]+\/(.+)$/.exec(p)) || (m = /^\/Volumes\/[^/]+\/(.+)$/.exec(p))) {
    rank = 2; platform = "Mac"; tail = m[1];
  } else return null;
  if (tail.split("/").some((s) => !s || s === "." || s === "..")) return null;
  return { key: tail, rank, platform };
}

export function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

interface Member { sub: string; cwd: string; rank: number; platform: string }
interface RootPlan { root: string; snapshot: string; files: Map<string, string>; needsMerge: boolean; warnings: string[] }
export interface PathMergePlan {
  cwd: string;
  sessionDir: string;
  key: string;
  members: Member[];
  keeper: string;
  roots: RootPlan[];
}

function lstat(p: string): fs.Stats | undefined {
  try { return fs.lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
function head(p: string): string {
  const fd = fs.openSync(p, "r");
  try { const b = Buffer.alloc(16384); return b.toString("utf8", 0, fs.readSync(fd, b, 0, b.length, 0)); }
  finally { fs.closeSync(fd); }
}
function digest(p: string): string { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

// Folder encoding is lossy (a-b vs a/b). Only use it as a prefilter; confirm using stored cwd.
function encodedKey(sub: string): string | null {
  return /^--mnt-[a-zA-Z]-(.+)--$/.exec(sub)?.[1]
    ?? /^--[a-zA-Z]--(.+)--$/.exec(sub)?.[1]
    ?? /^--(?:Users|Volumes)-[^-]+-(.+)--$/.exec(sub)?.[1] ?? null;
}
function storedCwd(root: string, sub: string, currentCwd: string): string | undefined {
  if (sub === encodeCwd(currentCwd)) return currentCwd;
  for (const kind of ["sessions", "garden"]) {
    const dir = path.join(root, kind, sub);
    if (!lstat(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!(kind === "sessions" ? f.endsWith(".jsonl") : /\.l[0-3]\.md$/.test(f))) continue;
      const file = path.join(dir, f);
      if (!fs.lstatSync(file).isFile()) continue;
      const text = head(file);
      let cwd: string | undefined;
      if (kind === "sessions") {
        try { const h = JSON.parse(text.split("\n")[0]); if (h.type === "session") cwd = h.cwd; } catch { continue; }
      } else cwd = parseGardenFrontmatter(text).cwd;
      if (typeof cwd === "string" && encodeCwd(cwd) === sub) return cwd;
    }
  }
}

function inspectRoot(root: string, members: Member[], keeper: string): RootPlan {
  const entries: string[] = [];
  const files = new Map<string, string>();
  const hashes = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const conflicts = new Set<string>();
  const isGarden = path.basename(root) === "garden";
  const realDirs = new Set<string>();
  let missing = false;
  for (const { sub } of members) {
    const dir = path.join(root, sub);
    const st = lstat(dir);
    if (!st) { entries.push(`${sub}:missing`); missing = true; continue; }
    const real = fs.realpathSync(dir);
    if (path.dirname(real) !== fs.realpathSync(root)) throw new Error(`目录链接指向分组根之外，需手动处理: ${dir}`);
    if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目录: ${dir}`);
    entries.push(`${sub}:${st.isSymbolicLink() ? fs.readlinkSync(dir) : "directory"}`);
    realDirs.add(real);
    for (const f of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, f);
      const entry = fs.lstatSync(file);
      // Mono rebuilds this metadata at the new location; never copy it or snapshot its contents.
      // Only the actual .mono directory is exempt (not a symlink or any other nested directory).
      if (f === ".mono" && entry.isDirectory()) continue;
      if (!entry.isFile()) throw new Error(`不支持嵌套目录或文件链接: ${file}`);
      const hash = digest(file);
      entries.push(`${sub}/${f}:${hash}${isGarden ? `:${entry.mtimeMs}` : ""}`);
      if (hashes.has(f) && hashes.get(f) !== hash) {
        if (!isGarden) throw new Error(`同名文件内容不同，未执行合并: ${file}`);
        conflicts.add(f);
      }
      // Equal timestamps retain the first candidate (WSL > Windows > Mac).
      if (!files.has(f) || (isGarden && entry.mtimeMs > mtimes.get(f)!)) {
        hashes.set(f, hash);
        mtimes.set(f, entry.mtimeMs);
        files.set(f, file);
      }
    }
  }
  const keeperDir = path.join(root, keeper);
  const needsMerge = missing || realDirs.size > 1 || !lstat(keeperDir) || lstat(keeperDir)!.isSymbolicLink();
  const warnings = [...conflicts].map((f) => `garden 同名文件内容不同，已按修改时间保留较新版本（同时间按平台优先级）: ${files.get(f)}`);
  return { root, files, needsMerge, warnings, snapshot: JSON.stringify(entries) };
}

/** Only compares groups matching the current cwd. No global conflict chooser. */
export function preparePathMerge(cwd: string, sessionDir: string): PathMergePlan | null {
  const current = stripProjectPrefix(cwd);
  if (!current) throw new Error(`不支持的当前路径前缀: ${cwd}`);
  const sessionsRoot = path.dirname(sessionDir);
  if (path.basename(sessionsRoot) !== "sessions" || path.basename(sessionDir) !== encodeCwd(cwd)) {
    throw new Error("仅支持当前 cwd 对应的标准 sessions 分组（不支持自定义 session-dir 或其他项目的会话）");
  }
  const agentRoot = path.dirname(sessionsRoot);
  const roots = [sessionsRoot, path.join(agentRoot, "garden")];
  const names = new Set([encodeCwd(cwd)]);
  for (const root of roots) {
    if (!lstat(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if ((e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith("--")) names.add(e.name);
    }
  }
  const members: Member[] = [];
  const keyEncoded = current.key.replace(/[/\\:]/g, "-");
  for (const sub of [...names].sort()) {
    // Mac usernames/volume names can contain '-': let those names reach the metadata check.
    if (sub !== encodeCwd(cwd) && encodedKey(sub) !== keyEncoded
      && !(/^--(?:Users|Volumes)-/.test(sub) && sub.endsWith(`-${keyEncoded}--`))) continue;
    const original = storedCwd(agentRoot, sub, cwd);
    const normalized = original && stripProjectPrefix(original);
    if (normalized && normalized.key === current.key) members.push({ sub, cwd: original!, rank: normalized.rank, platform: normalized.platform });
  }
  if (members.length < 2) return null;
  members.sort((a, b) => a.rank - b.rank || a.sub.localeCompare(b.sub));
  // No secondary chooser for this low-frequency feature: ambiguous equal-priority keepers fail closed.
  if (members[0].rank === members[1].rank) throw new Error("存在多个同优先级保留目录，请先手动整理后重试");
  const keeper = members[0].sub;
  const plans = roots.map((root) => inspectRoot(root, members, keeper));
  if (plans.every((r) => !r.needsMerge)) return null;
  return { cwd, sessionDir, key: current.key, members, keeper, roots: plans };
}

/** Synchronous commit: Pi cannot append between rename/link in this process. Other writers must be stopped. */
export function applyPathMerge(plan: PathMergePlan): string[] {
  const fresh = preparePathMerge(plan.cwd, plan.sessionDir);
  if (!fresh || fresh.keeper !== plan.keeper || JSON.stringify(fresh.members) !== JSON.stringify(plan.members)
    || fresh.roots.some((r, i) => r.snapshot !== plan.roots[i].snapshot)) throw new Error("目录内容已变化，请重新检测并确认");
  const id = randomUUID();
  const stages: { root: string; backup: string; stage: string; moved: string[]; installed: string[] }[] = [];
  try {
    // Stage all data and probe directory-symlink support before touching any original directory.
    for (const r of fresh.roots.filter((r) => r.needsMerge)) {
      fs.mkdirSync(r.root, { recursive: true });
      const backup = path.join(r.root, `.path-merge-${id}`);
      fs.mkdirSync(backup);
      const stage = path.join(backup, "merged");
      const op = { root: r.root, backup, stage, moved: [] as string[], installed: [] as string[] };
      stages.push(op);
      fs.mkdirSync(stage);
      for (const [name, src] of r.files) {
        const dest = path.join(stage, name);
        fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        if (digest(dest) !== digest(src)) throw new Error(`复制校验失败: ${src}`);
        const st = fs.statSync(src); fs.utimesSync(dest, st.atime, st.mtime);
      }
      const probe = path.join(backup, "probe");
      fs.symlinkSync("merged", probe, "dir"); fs.unlinkSync(probe);
    }
    // Revalidate after staging (including external writers) and before the first rename.
    for (const r of fresh.roots) {
      if (inspectRoot(r.root, fresh.members, fresh.keeper).snapshot !== r.snapshot) throw new Error("复制期间目录已变化，请停止其他写入后重试");
    }
    for (const op of stages) {
      for (const { sub } of fresh.members) {
        const dir = path.join(op.root, sub);
        if (lstat(dir)) { fs.renameSync(dir, path.join(op.backup, sub)); op.moved.push(sub); }
      }
      fs.renameSync(op.stage, path.join(op.root, fresh.keeper)); op.installed.push(fresh.keeper);
      for (const { sub } of fresh.members) {
        if (sub === fresh.keeper) continue;
        fs.symlinkSync(fresh.keeper, path.join(op.root, sub), "dir"); op.installed.push(sub);
      }
    }
  } catch (e) {
    const errors: string[] = [];
    for (const op of stages.reverse()) {
      try {
        for (const sub of op.installed.reverse()) {
          const p = path.join(op.root, sub);
          if (sub === fresh.keeper) fs.renameSync(p, op.stage); else fs.unlinkSync(p);
        }
        for (const sub of op.moved.reverse()) fs.renameSync(path.join(op.backup, sub), path.join(op.root, sub));
      } catch (err) { errors.push(`${op.backup}: ${String(err)}`); }
    }
    throw new Error(`${(e as Error).message}；${errors.length ? `回滚未完成: ${errors.join("; ")}` : "原目录已保留/恢复"}；备份/暂存: ${stages.map((s) => s.backup).join(", ")}`);
  }
  // Delete disposable metadata only after every root has committed, so rollback retains it.
  // Cleanup failure must not roll back an otherwise successful merge.
  for (const op of stages) {
    for (const sub of op.moved) {
      const mono = path.join(op.backup, sub, ".mono");
      if (!lstat(path.join(op.backup, sub))?.isDirectory() || !lstat(mono)?.isDirectory()) continue;
      try { fs.rmSync(mono, { recursive: true, force: true }); }
      catch (e) { throw new Error(`目录合并已完成，但旧 .mono 清理失败: ${mono}；${(e as Error).message}；备份: ${stages.map((s) => s.backup).join(", ")}`); }
    }
  }
  return stages.map((op) => op.backup);
}
