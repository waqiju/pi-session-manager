import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSampleJsonl } from "./sample.ts";
import { GARDEN_VERSION } from "../src/render/shared.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function setup(): { root: string; sessionsDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "garden-test-"));
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(path.join(sessionsDir, "--tmp-proj--"), { recursive: true });
  writeFileSync(path.join(sessionsDir, "--tmp-proj--", "2026-09-14T01-00-00_test.jsonl"), buildSampleJsonl());
  return { root, sessionsDir };
}

test("CLI: 目录模式生成三级 markdown，增量跳过", () => {
  const { root, sessionsDir } = setup();
  try {
    const out1 = execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(out1.includes("1 个 session"), out1);
    assert.ok(out1.includes("1 更新"), out1);

    const gardenDir = path.join(root, "garden", "--tmp-proj--");
    const l0 = path.join(gardenDir, "2026-09-14T01-00-00_test.l0.md");
    const l1 = path.join(gardenDir, "2026-09-14T01-00-00_test.l1.md");
    const l2 = path.join(gardenDir, "2026-09-14T01-00-00_test.l2.md");
    for (const f of [l0, l1, l2]) assert.ok(existsSync(f), `应生成 ${f}`);

    const s0 = readFileSync(l0, "utf8");
    const s1 = readFileSync(l1, "utf8");
    const s2 = readFileSync(l2, "utf8");
    assert.ok(s0.length > s1.length && s1.length > s2.length, "l0 > l1 > l2");

    // 第二次运行：全部跳过
    const out2 = execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(out2.includes("0 更新"), out2);
    assert.ok(out2.includes("1 已是最新"), out2);

    // 版本标记被移除 → 重新生成（逻辑变更自动全量刷新的依据）
    const old = readFileSync(l0, "utf8").replace(/^version: "[^"]+"$/m, "version: \"0.0.0-old\"");
    writeFileSync(l0, old);
    const out3 = execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(out3.includes("1 更新"), out3);
    const refreshed = readFileSync(l0, "utf8");
    assert.ok(refreshed.includes(`version: "${GARDEN_VERSION}"`), "应重新生成并恢复当前版本标记");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: 单文件模式 + -o", () => {
  const { root, sessionsDir } = setup();
  try {
    const src = path.join(sessionsDir, "--tmp-proj--", "2026-09-14T01-00-00_test.jsonl");
    const outDir = path.join(root, "out");
    const out = execFileSync(process.execPath, [CLI, src, "-o", outDir], { encoding: "utf8" });
    assert.ok(out.includes("1 更新"), out);
    assert.ok(existsSync(path.join(outDir, "--tmp-proj--", "2026-09-14T01-00-00_test.l0.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
