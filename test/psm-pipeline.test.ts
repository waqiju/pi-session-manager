import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkPipeline, loadPipeline, pipelineArgs, preparePipeline } from "../src/psm/pipeline.ts";
import { startPipeline } from "../src/psm/cli.ts";
import { restartRun, requestStop } from "../src/psm/lifecycle.ts";
import { inspectRun, listRuns } from "../src/psm/runs.ts";
import { delay, readJson, writeJson } from "../src/psm/files.ts";

const fixture = fileURLToPath(new URL("./fixtures/psm-fake-pi.ts", import.meta.url));
const cli = fileURLToPath(new URL("../src/psm/cli.ts", import.meta.url));
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (check()) return; await delay(30); }
  throw new Error("Timed out");
}
function setup(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), "psm-pipeline-"));
  const cwd = path.join(root, "cwd with spaces");
  const home = path.join(root, "psm");
  const source = path.join(root, "pi");
  mkdirSync(cwd); mkdirSync(source);
  const previous = process.env.PSM_HOME;
  process.env.PSM_HOME = home;
  writeJson(path.join(home, "config.json"), { defaultModel: "fixture/test", piCommand: [process.execPath, fixture], pollMs: 30, stableMs: 60, startupTimeoutMs: 3000 });
  const put = (base: string, name: string, expression: string) => {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "pipeline.mjs"), `export default async ({cwd,pipelineDir}) => (${expression});`);
    return dir;
  };
  t.after(async () => {
    for (const run of listRuns(home, true)) if (run.alive) {
      await requestStop(run.dir); await until(() => !inspectRun(run.dir).alive);
    }
    if (previous === undefined) delete process.env.PSM_HOME; else process.env.PSM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, home, source, put };
}

test("local pipeline shadows global; malformed local and unsafe names never fall back", async (t) => {
  const { cwd, home, put } = setup(t);
  put(home, "demo", `{resources:'isolated',group:'global'}`);
  assert.equal((await loadPipeline(cwd, home, "demo")).group, "global");
  const local = put(path.join(cwd, ".psm"), "demo", `{resources:'isolated',group:'local'}`);
  assert.equal((await loadPipeline(cwd, home, "demo")).group, "local");
  writeFileSync(path.join(local, "pipeline.mjs"), "export default 42;");
  await assert.rejects(loadPipeline(cwd, home, "demo"), /default function/);
  rmSync(path.join(local, "pipeline.mjs"));
  await assert.rejects(loadPipeline(cwd, home, "demo"), /Missing pipeline entry/);
  for (const name of ["../escape", "runs", "", "a/b", "registry", "ids"]) await assert.rejects(loadPipeline(cwd, home, name), /name/);
});

test("schema rejects session overrides and invalid fields before launching", async (t) => {
  const { cwd, home, put } = setup(t);
  for (const [i, value] of [
    `{resources:'other'}`, `{resources:'isolated',agentDir:'x'}`, `{session:'x'}`,
    `{piArgs:['--session','elsewhere']}`, `{piArgs:['--model=x']}`, `{tools:['read','+bash']}`,
    `{disable:['typo']}`, `{config:{turnTimeoutMs:0}}`, `{config:{piCommand:['bad']}}`, `{thinking:'bad'}`,
    `{extensions:['missing.ts']}`, `{tools:['read,bash']}`,
  ].entries()) {
    put(home, `bad${i}`, value);
    await assert.rejects(loadPipeline(cwd, home, `bad${i}`));
  }
  assert.equal(listRuns(home, true).length, 0);
});

test("inherit copies private configuration, resolves relative resources, keeps PSM authentication, and detects drift", async (t) => {
  const { cwd, home, source, root, put } = setup(t);
  mkdirSync(path.join(source, "extras"));
  writeFileSync(path.join(source, "extras/tool.ts"), "export default () => {};");
  writeFileSync(path.join(source, "AGENTS.md"), "Inherited instructions");
  writeJson(path.join(source, "settings.json"), { extensions: ["./extras/tool.ts"], packages: [], defaultModel: "not-used", defaultTools: ["read"] });
  writeJson(path.join(source, "auth.json"), { secret: "must-not-copy" });
  writeJson(path.join(source, "models.json"), { secret: "must-not-copy" });
  writeJson(path.join(source, "mcp.json"), { mcpServers: {} });
  put(home, "inherit", `{agentDir:${JSON.stringify(source)},disable:['skills'],tools:['+grep'],excludeTools:['write']}`);
  const p = await loadPipeline(cwd, home, "inherit");
  assert.equal(p.resources, "inherit");
  const agent = path.join(root, "private"); mkdirSync(agent);
  preparePipeline(p, agent, cwd);
  assert.deepEqual(readJson(path.join(agent, "settings.json")).extensions, [path.join(source, "extras/tool.ts")]);
  assert.equal(readJson(path.join(agent, "settings.json")).defaultModel, undefined);
  assert.equal(readFileSync(path.join(agent, "AGENTS.md"), "utf8"), "Inherited instructions");
  assert.equal(existsSync(path.join(agent, "auth.json")), false);
  assert.equal(existsSync(path.join(agent, "models.json")), false);
  assert.ok(pipelineArgs(p).includes("--approve"));
  assert.ok(pipelineArgs(p).includes("--no-skills"));
  assert.ok(!pipelineArgs(p).includes("--no-extensions"));
  checkPipeline(p);
  writeFileSync(path.join(source, "extras/tool.ts"), "export default () => { throw Error('changed'); };");
  assert.throws(() => checkPipeline(p), /resource changed/);
});

test("isolated explicit resources, CLI file prompt, group override, pinned restart and drift refusal", async (t) => {
  const { cwd, home, root, put } = setup(t);
  const dir = put(home, "demo", `{resources:'isolated',group:'from-pipeline',model:'fuzzy',thinking:'high',extensions:[pipelineDir+'/tool.ts'],skills:[pipelineDir+'/SKILL.md'],config:{idleTimeoutMs:0}}`);
  writeFileSync(path.join(dir, "tool.ts"), "export default () => {};");
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: test\ndescription: Test\n---\nInstructions");
  const input = path.join(root, "prompt.md"); writeFileSync(input, "中文\nfrom file");
  const result = await promisify(execFile)(process.execPath, [cli, "run", "demo", "--file", input, "--group", "override", "--json"], { cwd });
  const run = JSON.parse(result.stdout);
  assert.equal(run.group, "override");
  assert.equal(run.pipeline.resources, "isolated");
  assert.equal(run.config.idleTimeoutMs, 0);
  const observed = readJson(path.join(run.dir, "observed.json"));
  assert.ok(observed.args.includes("--no-context-files"));
  assert.ok(observed.args.includes(path.join(dir, "tool.ts")));
  assert.ok(observed.args.includes(path.join(dir, "SKILL.md")));
  assert.equal(readFileSync(path.join(run.dir, "001.in.md"), "utf8"), "中文\nfrom file");
  await until(() => readJson(path.join(run.dir, "001.status.json"), {}).state === "completed");
  await requestStop(run.dir); await until(() => inspectRun(run.dir).state === "stopped");
  assert.equal((await restartRun(run.dir)).restartCount, 1);
  await requestStop(run.dir); await until(() => inspectRun(run.dir).state === "stopped");
  writeFileSync(path.join(dir, "tool.ts"), "changed");
  await assert.rejects(restartRun(run.dir), /resource changed/);
  assert.equal(inspectRun(run.dir).restartCount, 1);
});

test("restart never executes pipeline factory again", async (t) => {
  const { cwd, home, root, put } = setup(t);
  const marker = path.join(root, "count");
  const dir = put(home, "once", `{resources:'isolated'}`);
  writeFileSync(path.join(dir, "pipeline.mjs"), `import fs from 'node:fs'; export default () => { const file=${JSON.stringify(marker)}; if(fs.existsSync(file)) throw Error('ran twice'); fs.writeFileSync(file,'1'); return {resources:'isolated'}; };`);
  const run = await startPipeline(cwd, "once", "hello");
  await until(() => readJson(path.join(run.dir, "001.status.json"), {}).state === "completed");
  await requestStop(run.dir); await until(() => inspectRun(run.dir).state === "stopped");
  assert.equal((await restartRun(run.dir)).restartCount, 1);
});
