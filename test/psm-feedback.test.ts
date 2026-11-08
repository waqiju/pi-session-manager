import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allocateRunId, findRun } from "../src/psm/runs.ts";
import { startRun } from "../src/psm/cli.ts";
import { writeJson, delay } from "../src/psm/files.ts";
import { inspectRun } from "../src/psm/runs.ts";
import { formatRuns } from "../src/psm/table.ts";
import { visibleWidth } from "../src/textwidth.ts";

function home(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), "psm-feedback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("six-digit reservations are concurrent, permanent, bounded and cross 999", async (t) => {
  const root = home(t);
  assert.equal(allocateRunId(root), "000001");
  mkdirSync(path.join(root, "ids/000999"));
  assert.equal(allocateRunId(root), "001000");
  const module = new URL("../src/psm/runs.ts", import.meta.url).href;
  const exec = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath,
    ["--input-type=module", "-e", `import { allocateRunId } from ${JSON.stringify(module)}; console.log(allocateRunId(process.argv[1]));`, root])));
  assert.deepEqual(results.map((r) => r.stdout.trim()).sort(), Array.from({ length: 8 }, (_, i) => String(1001 + i).padStart(6, "0")));
  mkdirSync(path.join(root, "ids/999999"));
  assert.throws(() => allocateRunId(root), /limit reached/);
});

test("legacy UUID lookup and exact matches take precedence over prefixes", (t) => {
  const root = home(t);
  for (const id of ["000001", "000001ab-legacy-uuid", "984dbb89-a924-4134-bbd7-7c3f870f38d5"]) {
    const dir = path.join(root, id);
    writeJson(path.join(dir, "run.json"), { id, dir, state: "stopped", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    writeJson(path.join(root, "registry", `${id}.json`), { id, dir });
  }
  assert.equal(findRun("000001", root).id, "000001");
  assert.match(findRun("984dbb89", root).id, /^984dbb89-/);
  assert.throws(() => findRun("000", root), /Ambiguous/);
});

test("new runs link the selected models file without copying it", async (t) => {
  const root = home(t);
  const previous = process.env.PSM_HOME;
  process.env.PSM_HOME = root;
  t.after(() => { if (previous === undefined) delete process.env.PSM_HOME; else process.env.PSM_HOME = previous; });
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  writeJson(path.join(root, "config.json"), { defaultModel: "fake", models: { fake: { provider: "fixture", model: "test" } },
    piCommand: [process.execPath, new URL("./fixtures/psm-fake-pi.ts", import.meta.url).pathname], pollMs: 30, stableMs: 90 });
  const source = path.join(root, "models.json");
  writeJson(source, { providers: {} });
  const run = await startRun(cwd, "fast");
  try {
    const link = path.join(run.dir, "agent/models.json");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), source);
  } finally {
    writeJson(path.join(run.dir, "stop.json"), { token: run.token });
    for (let i = 0; i < 200 && inspectRun(run.dir).state !== "stopped"; i++) await delay(30);
    assert.equal(inspectRun(run.dir).state, "stopped");
  }
});

test("table aligns CJK and long values within terminal width, strips controls", () => {
  const run: any = { id: "000001", state: "running", alive: true, group: "研究", model: { provider: "test", model: "模型".repeat(30) }, currentTurn: "002", updatedAt: new Date().toISOString() };
  for (const width of [80, 120]) {
    const output = formatRuns([run, { ...run, group: "bad\n\x1b[31mgroup" }], width);
    const lines = output.split("\n").slice(0, -1);
    assert.equal(new Set(lines.map(visibleWidth)).size, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
    assert.ok(!output.includes("\x1b"));
    assert.match(output, /002/);
  }
  assert.match(formatRuns([]), /0 run\(s\)/);
});
