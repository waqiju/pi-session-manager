import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { writeJson } from "./files.ts";
import { pipelineArgs } from "./pipeline.ts";

/** Query Pi's catalog with PSM credentials, without allocating a run or sending a prompt. */
export async function listModels(cwd: string, search?: string): Promise<string> {
  if (search !== undefined && (!search.trim() || search.startsWith("-"))) throw new Error("Model search must be nonempty and must not start with '-'");
  const loaded = loadConfig(cwd);
  const agent = mkdtempSync(path.join(tmpdir(), "psm-models-"));
  try {
    if (loaded.modelsFile) symlinkSync(loaded.modelsFile, path.join(agent, "models.json"));
    writeJson(path.join(agent, "auth.json"), loaded.auth);
    writeJson(path.join(agent, "settings.json"), { packages: [], quietStartup: true });
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: agent, PI_GARDEN: "0" };
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    const [command, ...prefix] = loaded.config.piCommand;
    let output: string;
    try {
      const result = await promisify(execFile)(command, [...prefix, ...pipelineArgs(), "--no-context-files", "--no-session", "--list-models", ...(search === undefined ? [] : [search])],
        { cwd, env, timeout: loaded.config.startupTimeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
      // Pi diagnostics can quote models.json, including credentials. Never forward them.
      if (result.stderr.trim()) throw new Error("Pi reported diagnostics");
      output = result.stdout;
    } catch {
      throw new Error("Pi model listing failed or timed out; check piCommand and PSM model/auth configuration (Pi diagnostics withheld because they may contain credentials)");
    }
    return `Default model expression: ${loaded.config.defaultModel ?? "(not set)"}\nModels file: ${loaded.modelsFile ?? "(Pi built-in catalog)"}\n${output}`;
  } finally {
    rmSync(agent, { recursive: true, force: true });
  }
}
