import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/psm/files.ts";

const cli = fileURLToPath(new URL("../src/psm/cli.ts", import.meta.url));
const exec = promisify(execFile);
function setup(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), "psm-catalog-test-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, PSM_HOME: home, PI_SESSION_ID: "parent-session", PI_MODEL: "parent-model" };
  return { root, cwd, home, env };
}

test("models uses PSM auth/model precedence, isolates parent env and cleans temporary files on success/failure", async (t) => {
  const { root, cwd, home, env } = setup(t);
  const observed = path.join(root, "observed.json");
  const fixture = path.join(root, "pi.mjs");
  writeFileSync(fixture, `import fs from 'node:fs'; import path from 'node:path';
const agent=process.env.PI_CODING_AGENT_DIR;
const read=name=>JSON.parse(fs.readFileSync(path.join(agent,name),'utf8'));
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({agent,args:process.argv.slice(2),models:fs.realpathSync(path.join(agent,'models.json')),auth:read('auth.json'),settings:read('settings.json'),session:process.env.PI_SESSION_ID,model:process.env.PI_MODEL}));
if(process.argv.includes('fail')) { console.error('secret-provider-key'); process.exit(1); }
console.log('provider model context');`);
  writeJson(path.join(home, "config.json"), { piCommand: [process.execPath, fixture], defaultModel: "global/model" });
  writeJson(path.join(home, "auth.json"), { global: { type: "api_key", key: "global-key" } });
  writeJson(path.join(cwd, ".psm/auth.json"), { local: { type: "api_key", key: "local-key" } });
  writeJson(path.join(home, "models.json"), {});
  writeJson(path.join(cwd, ".psm/config.json"), { defaultModel: "local/model" });
  const run = (search: string) => exec(process.execPath, [cli, "models", search], { cwd, env });
  const first = await run("deepseek");
  assert.match(first.stdout, /Default model expression: local\/model/);
  let snapshot = JSON.parse(readFileSync(observed, "utf8"));
  assert.equal(snapshot.models, path.join(home, "models.json"));
  assert.equal(snapshot.auth.global.key, "global-key");
  assert.equal(snapshot.auth.local.key, "local-key");
  assert.equal(snapshot.session, undefined);
  assert.equal(snapshot.model, undefined);
  for (const flag of ["--offline", "--no-session", "--no-extensions", "--no-mcp", "--list-models", "deepseek"]) assert.ok(snapshot.args.includes(flag));
  assert.equal(existsSync(snapshot.agent), false);
  writeJson(path.join(cwd, ".psm/models.json"), {});
  await run("deepseek");
  snapshot = JSON.parse(readFileSync(observed, "utf8"));
  assert.equal(snapshot.models, path.join(cwd, ".psm/models.json"));
  await assert.rejects(run("fail"), (error: any) => {
    assert.doesNotMatch(error.stderr, /secret-provider-key/);
    assert.match(error.stderr, /model listing failed/);
    return true;
  });
  snapshot = JSON.parse(readFileSync(observed, "utf8"));
  assert.equal(existsSync(snapshot.agent), false);
  for (const directory of [path.join(home, "ids"), path.join(home, "registry"), path.join(cwd, ".psm/runs")]) assert.equal(existsSync(directory), false);
  await assert.rejects(exec(process.execPath, [cli, "models", "--json"], { cwd, env }), /Usage: psm models/);
});

test("real Pi lists a PSM custom model without a run or model API request", { skip: !process.env.PSM_REAL_PI }, async (t) => {
  const { cwd, home, env } = setup(t);
  writeJson(path.join(home, "config.json"), { piCommand: [process.env.PSM_REAL_PI] });
  writeJson(path.join(home, "models.json"), { providers: { "psm-catalog-fixture": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture-only",
    models: [{ id: "catalog-model", contextWindow: 32768, maxTokens: 1024 }],
  } } });
  const result = await exec(process.execPath, [cli, "models", "psm-catalog-fixture"], { cwd, env });
  assert.match(result.stdout, /catalog-model/);
  assert.doesNotMatch(result.stdout, /fixture-only/);
  assert.equal(existsSync(path.join(home, "ids")), false);
  assert.equal(existsSync(path.join(cwd, ".psm/runs")), false);
});
