import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readJson } from "./files.ts";

type ObjectMap = Record<string, any>;
export interface ModelChoice { provider: string; model: string; thinking?: string }
export interface Config {
  defaultModel?: string;
  models: Record<string, ModelChoice>;
  piCommand: string[];
  pollMs: number;
  stableMs: number;
  startupTimeoutMs: number;
  turnTimeoutMs: number;
}

export function psmHome(): string { return path.resolve(process.env.PSM_HOME || path.join(homedir(), ".psm")); }

function object(value: any): value is ObjectMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Object fields merge; arrays replace. */
export function merge(base: any, override: any): any {
  if (!object(base) || !object(override)) return override;
  const result = Object.fromEntries(Object.entries(base));
  for (const [key, value] of Object.entries(override)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`Invalid configuration key: ${key}`);
    result[key] = object(value) ? merge(object(base[key]) ? base[key] : {}, value) : value;
  }
  return result;
}

export function loadConfig(cwd: string, home = psmHome()) {
  const local = path.join(cwd, ".psm");
  const load = (name: string) => {
    const global = readJson(path.join(home, name), {});
    const project = local === home ? {} : readJson(path.join(local, name), {});
    if (!object(global) || !object(project)) throw new Error(`${name} must contain a JSON object`);
    return merge(global, project);
  };
  const raw = load("config.json");
  const allowed = new Set(["defaultModel", "models", "piCommand", "pollMs", "stableMs", "startupTimeoutMs", "turnTimeoutMs"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown PSM config field: ${key}`);
  const config: Config = { models: {}, piCommand: ["pi"], pollMs: 500, stableMs: 1000,
    startupTimeoutMs: 30000, turnTimeoutMs: 3600000, ...raw };
  if (!Array.isArray(config.piCommand) || !config.piCommand.length || config.piCommand.some((s) => typeof s !== "string" || !s))
    throw new Error("piCommand must be a nonempty argv array");
  if (!object(config.models)) throw new Error("config.models must be an alias map");
  if (config.defaultModel !== undefined && typeof config.defaultModel !== "string") throw new Error("defaultModel must be a string");
  for (const key of ["pollMs", "stableMs", "startupTimeoutMs", "turnTimeoutMs"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 10) throw new Error(`${key} must be an integer >= 10`);
  }
  let modelsFile: string | undefined;
  for (const directory of [...new Set([local, home])]) {
    const candidate = path.resolve(directory, "models.json");
    if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
    // Do not expose JSON parser excerpts: the file can contain literal API keys.
    try {
      if (!object(readJson(candidate))) throw new Error("Expected object");
    } catch { throw new Error(`Invalid models.json: ${candidate}; expected a readable JSON object`); }
    modelsFile = candidate;
    break;
  }
  return { config, modelsFile, auth: load("auth.json"), home, local };
}

export function selectModel(config: Config, name = config.defaultModel): ModelChoice {
  if (!name) throw new Error("Specify a model alias or set defaultModel in .psm/config.json");
  const choice = config.models[name];
  if (!choice || typeof choice.provider !== "string" || !choice.provider || typeof choice.model !== "string" || !choice.model)
    throw new Error(`Unknown or invalid model alias: ${name}; define models.${name} with provider and model`);
  if (choice.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(choice.thinking))
    throw new Error(`Invalid thinking level for ${name}`);
  return { provider: choice.provider, model: choice.model, ...(choice.thinking ? { thinking: choice.thinking } : {}) };
}
