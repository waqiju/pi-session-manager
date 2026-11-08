import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "./files.ts";
import type { Config } from "./config.ts";

const resourceKinds = ["extensions", "skills", "promptTemplates", "themes", "mcp", "contextFiles"] as const;
type ResourceKind = typeof resourceKinds[number];
const timingKeys = ["pollMs", "stableMs", "startupTimeoutMs", "turnTimeoutMs", "idleTimeoutMs"] as const;
export interface Pipeline {
  name: string;
  file: string;
  resources: "inherit" | "isolated";
  agentDir?: string;
  model?: string;
  thinking?: string;
  group?: string;
  extensions: string[];
  skills: string[];
  promptTemplates: string[];
  disable: ResourceKind[];
  tools?: string[];
  excludeTools: string[];
  appendSystemPrompt?: string;
  piArgs: string[];
  config: Partial<Config>;
  fingerprints: Record<string, string>;
}
const validName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((v) => text(v, label));
}
function absolute(value: string, base: string): string {
  return path.resolve(base, value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value);
}

/** Content fingerprints, including symlink targets and directory membership. Not a sandbox or dependency lock. */
export function fingerprint(root: string): string {
  const hash = createHash("sha256");
  const walk = (file: string, ancestors: Set<string>) => {
    hash.update(JSON.stringify(file));
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info) { hash.update("missing"); return; }
    const real = realpathSync(file);
    hash.update(real);
    if (ancestors.has(real)) { hash.update("cycle"); return; }
    const stat = statSync(file);
    if (stat.isFile()) { hash.update(readFileSync(file)); return; }
    if (!stat.isDirectory()) throw new Error(`Resource is not a regular file or directory: ${file}`);
    const next = new Set(ancestors).add(real);
    for (const name of readdirSync(file).sort()) {
      if ([".git", "node_modules", ".psm"].includes(name)) continue;
      walk(path.join(file, name), next);
    }
  };
  walk(root, new Set());
  return hash.digest("hex");
}
export function checkPipeline(pipeline?: Pipeline): void {
  if (!pipeline) return;
  for (const [file, expected] of Object.entries(pipeline.fingerprints)) {
    let actual: string;
    try { actual = fingerprint(file); } catch { actual = "unreadable"; }
    if (actual !== expected) throw new Error(`Pipeline resource changed: ${file}; restore the resource or create a new run with psm run ${pipeline.name}`);
  }
}

export interface PipelineCandidate {
  name: string;
  scope: "local" | "global";
  directory: string;
  file: string;
  entryExists: boolean;
}
export interface PipelineListing extends PipelineCandidate { shadowed: PipelineCandidate[] }

function pipelineRoots(cwd: string, home: string): { directory: string; scope: "local" | "global" }[] {
  const local = path.resolve(cwd, ".psm", "pipelines");
  const global = path.resolve(home, "pipelines");
  return [{ directory: local, scope: "local" }, ...(local === global ? [] : [{ directory: global, scope: "global" as const }])];
}
function candidate(directory: string, name: string, scope: "local" | "global"): PipelineCandidate {
  const file = path.join(directory, "pipeline.mjs");
  let entryExists = false;
  try { entryExists = statSync(file).isFile(); } catch { /* missing, broken link or unreadable */ }
  return { name, scope, directory, file, entryExists };
}

/** Discover entries without importing modules or executing pipeline factories. */
export function listPipelines(cwd: string, home: string): PipelineListing[] {
  const found = new Map<string, PipelineListing>();
  for (const root of pipelineRoots(cwd, home)) {
    let names: string[];
    try { names = readdirSync(root.directory); }
    catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names.sort()) {
      if (!validName.test(name)) continue;
      const item = candidate(path.join(root.directory, name), name, root.scope);
      const previous = found.get(name);
      if (previous) previous.shadowed.push(item);
      else found.set(name, { ...item, shadowed: [] });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadPipeline(cwd: string, home: string, name: string): Promise<Pipeline> {
  if (!validName.test(name)) throw new Error("Invalid pipeline name");
  const roots = pipelineRoots(cwd, home).map((root) => path.join(root.directory, name));
  const directory = roots.find((root) => lstatSync(root, { throwIfNoEntry: false }));
  if (!directory) throw new Error(`Pipeline not found: ${name}; expected .psm/pipelines/${name}/pipeline.mjs or ${home}/pipelines/${name}/pipeline.mjs`);
  const file = path.join(directory, "pipeline.mjs");
  if (!existsSync(file)) throw new Error(`Missing pipeline entry: ${file}`);
  const before = fingerprint(directory);
  const module = await import(`${pathToFileURL(file).href}?load=${randomUUID()}`);
  if (typeof module.default !== "function") throw new Error("pipeline.mjs must export a default function");
  const raw = await module.default(Object.freeze({ cwd, pipelineDir: directory }));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Pipeline must return an object");
  const allowed = new Set(["model", "thinking", "group", "resources", "agentDir", "extensions", "skills", "promptTemplates", "disable", "tools", "excludeTools", "appendSystemPrompt", "piArgs", "config"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown pipeline field: ${key}`);
  const resources = raw.resources ?? "inherit";
  if (!["inherit", "isolated"].includes(resources)) throw new Error("resources must be inherit or isolated");
  if (resources === "isolated" && raw.agentDir !== undefined) throw new Error("agentDir is only valid with inherit");
  const pipeline: Pipeline = { name, file, resources, extensions: [], skills: [], promptTemplates: [],
    disable: strings(raw.disable, "disable") as ResourceKind[], excludeTools: strings(raw.excludeTools, "excludeTools"),
    piArgs: strings(raw.piArgs, "piArgs"), config: {}, fingerprints: { [directory]: before } };
  if (pipeline.disable.some((kind) => !resourceKinds.includes(kind))) throw new Error(`disable accepts ${resourceKinds.join(", ")}`);
  if (resources === "inherit") {
    pipeline.agentDir = absolute(text(raw.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi/agent"), "agentDir"), directory);
    if (!statSync(pipeline.agentDir).isDirectory()) throw new Error("agentDir must be a directory");
  }
  for (const key of ["model", "thinking", "group", "appendSystemPrompt"] as const) {
    if (raw[key] !== undefined) pipeline[key] = text(raw[key], key);
  }
  if (pipeline.group && !validName.test(pipeline.group)) throw new Error("Invalid pipeline group");
  if (pipeline.thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(pipeline.thinking)) throw new Error("Invalid thinking level");
  for (const key of ["extensions", "skills", "promptTemplates"] as const) {
    pipeline[key] = strings(raw[key], key).map((entry) => {
      if (key === "extensions" && /^builtin:(mcp|codemode|tool-search|llama\.cpp)$/.test(entry)) return entry;
      const resolved = absolute(entry, directory);
      if (!existsSync(resolved)) throw new Error(`Missing ${key} resource: ${resolved}`);
      pipeline.fingerprints[resolved] = fingerprint(resolved);
      return resolved;
    });
  }
  if (raw.tools !== undefined) {
    pipeline.tools = strings(raw.tools, "tools");
    const relative = pipeline.tools.filter((tool) => /^[+-]/.test(tool));
    if (relative.length && relative.length !== pipeline.tools.length) throw new Error("tools cannot mix plain names with +name/-name entries");
  }
  for (const tool of [...(pipeline.tools ?? []), ...pipeline.excludeTools]) if (tool.includes(",") || /\s/.test(tool)) throw new Error("Tool entries must be individual names or patterns");
  // Extra flags are deliberately narrow: never permit a second session, model, resource mode or prompt.
  for (const flag of pipeline.piArgs) if (!["--verbose", "--no-builtin-tools"].includes(flag)) throw new Error(`Unsupported piArgs flag: ${flag}; use structured pipeline fields`);
  if (raw.config !== undefined) {
    if (!raw.config || typeof raw.config !== "object" || Array.isArray(raw.config)) throw new Error("pipeline config must be an object");
    for (const [key, value] of Object.entries(raw.config)) {
      if (!(timingKeys as readonly string[]).includes(key)) throw new Error(`Unsupported pipeline config field: ${key}`);
      if (!Number.isSafeInteger(value) || (value as number) < (key === "idleTimeoutMs" ? 0 : 10)) throw new Error(`Invalid pipeline config ${key}`);
      (pipeline.config as any)[key] = value;
    }
  }
  checkPipeline(pipeline);
  return pipeline;
}

/** Build a private agent directory without importing the source model/auth settings. */
export function preparePipeline(pipeline: Pipeline, agent: string, cwd: string): void {
  const track = (file: string) => { pipeline.fingerprints[file] = fingerprint(file); };
  const source = pipeline.agentDir;
  let settings: Record<string, any> = { packages: [], quietStartup: true };
  if (source) {
    const sourceSettings = path.join(source, "settings.json");
    settings = readJson(sourceSettings, {});
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Inherited settings.json must be an object");
    track(sourceSettings);
    // Resolve paths before moving settings. Package filters remain relative to their package root.
    const resolveEntry = (entry: string) => {
      const prefix = /^[!+-]/.test(entry) ? entry[0] : "";
      const value = prefix ? entry.slice(1) : entry;
      return prefix + (value.startsWith("builtin:") ? value : absolute(value, source));
    };
    for (const kind of ["extensions", "skills", "prompts", "themes"]) {
      if (settings[kind]) settings[kind] = strings(settings[kind], `settings.${kind}`).map(resolveEntry);
      const dir = path.join(source, kind);
      track(dir);
      if (existsSync(dir)) symlinkSync(dir, path.join(agent, kind));
    }
    settings.packages = (settings.packages ?? []).map((entry: any) => {
      const value = typeof entry === "string" ? entry : entry.source;
      const resolved = /^(npm:|git:|https?:|git@)/.test(value) ? value : absolute(value, source);
      if (resolved.startsWith("/")) track(resolved);
      return typeof entry === "string" ? resolved : { ...entry, source: resolved };
    });
    // Installed packages keep their original dependency trees. Offline Pi uses these existing caches.
    for (const kind of ["git", "npm"]) {
      const dir = path.join(source, kind);
      if (existsSync(dir)) {
        symlinkSync(dir, path.join(agent, kind));
        if (kind === "git") track(dir);
        else {
          // Hash package source trees, not nested dependency installations.
          const modules = path.join(dir, "node_modules");
          for (const name of existsSync(modules) ? readdirSync(modules) : []) {
            if (name.startsWith(".")) continue;
            const root = path.join(modules, name);
            if (name.startsWith("@")) for (const child of readdirSync(root)) track(path.join(root, child));
            else track(root);
          }
        }
      }
    }
    for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "SYSTEM.md", "APPEND_SYSTEM.md", "mcp.json", "mcp-auth.json", "trust.json"]) {
      const file = path.join(source, name);
      if (name !== "mcp-auth.json") track(file);
      if (existsSync(file)) {
        copyFileSync(file, path.join(agent, name));
        chmodSync(path.join(agent, name), 0o600);
      }
    }
    // Project inheritance is explicit for this invocation; original .pi is never edited.
    track(path.join(cwd, ".pi"));
    track(path.join(homedir(), ".agents/skills"));
    for (let current = cwd; ; current = path.dirname(current)) {
      track(path.join(current, ".agents/skills"));
      for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) track(path.join(current, name));
      if (path.dirname(current) === current) break;
    }
    for (const kind of ["extensions", "skills", "prompts", "themes"]) {
      for (const entry of settings[kind] ?? []) {
        const file = entry.replace(/^[!+-]/, "");
        if (path.isAbsolute(file) && !/[!*?\[\]{}]/.test(file)) track(file);
      }
    }
    delete settings.sessionDir;
    delete settings.defaultModel;
    delete settings.defaultProvider;
  }
  settings.quietStartup = true;
  writeJson(path.join(agent, "settings.json"), settings);
  checkPipeline(pipeline);
}

export function pipelineArgs(pipeline?: Pipeline): string[] {
  if (!pipeline) return ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-approve", "--offline"];
  const isolated = pipeline.resources === "isolated";
  const disabled = new Set(isolated ? resourceKinds : pipeline.disable);
  const flags: Record<ResourceKind, string> = { extensions: "--no-extensions", skills: "--no-skills", promptTemplates: "--no-prompt-templates", themes: "--no-themes", mcp: "--no-mcp", contextFiles: "--no-context-files" };
  const args = ["--offline", isolated ? "--no-approve" : "--approve"];
  for (const kind of disabled) {
    // Explicit builtin:mcp opts an isolated pipeline into MCP support.
    if (kind === "mcp" && pipeline.extensions.includes("builtin:mcp") && !pipeline.disable.includes("mcp")) continue;
    args.push(flags[kind]);
  }
  for (const [key, flag] of [["extensions", "--extension"], ["skills", "--skill"], ["promptTemplates", "--prompt-template"]] as const) {
    for (const entry of pipeline[key]) args.push(flag, entry);
  }
  if (pipeline.tools) args.push(...(pipeline.tools.length ? ["--tools", pipeline.tools.join(",")] : ["--no-tools"]));
  if (pipeline.excludeTools.length) args.push("--exclude-tools", pipeline.excludeTools.join(","));
  if (pipeline.appendSystemPrompt) args.push("--append-system-prompt", pipeline.appendSystemPrompt);
  if (pipeline.thinking) args.push("--thinking", pipeline.thinking);
  return [...args, ...pipeline.piArgs];
}
