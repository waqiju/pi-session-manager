import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSampleJsonl } from "./sample.ts";
import { localDate, slugifyName } from "../src/naming.ts";
import { GARDEN_VERSION } from "../src/render/shared.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** 样例 fixture 的期望 base（name = "garden 开发会话"） */
const SAMPLE_BASE = `${localDate("2026-09-14T01:00:00.000Z")}-001-${slugifyName("garden 开发会话")}`;

function setup(): { root: string; sessionsDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "garden-test-"));
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(path.join(sessionsDir, "--tmp-proj--"), { recursive: true });
  writeFileSync(path.join(sessionsDir, "--tmp-proj--", "2026-09-14T01-00-00_test.jsonl"), buildSampleJsonl());
  return { root, sessionsDir };
}

/** 最小 session fixture：header + 可选 session_info + 一条 user 消息 */
function sessionJsonl(id: string, timestamp: string, name?: string): string {
  const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id, timestamp, cwd: "/tmp/proj" }];
  if (name !== undefined) lines.push({ type: "session_info", id: `${id}-n`, parentId: null, timestamp, name });
  lines.push({ type: "message", id: `${id}-m`, parentId: null, timestamp, message: { role: "user", content: "hi", timestamp: 1 } });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("CLI: 目录模式生成四级 markdown，增量跳过", () => {
  const { root, sessionsDir } = setup();
  try {
    const out1 = execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(out1.includes("1 个 session"), out1);
    assert.ok(out1.includes("1 更新"), out1);

    const gardenDir = path.join(root, "garden", "--tmp-proj--");
    const l0 = path.join(gardenDir, `${SAMPLE_BASE}.l0.md`);
    const l1 = path.join(gardenDir, `${SAMPLE_BASE}.l1.md`);
    const l2 = path.join(gardenDir, `${SAMPLE_BASE}.l2.md`);
    const l3 = path.join(gardenDir, `${SAMPLE_BASE}.l3.md`);
    for (const f of [l0, l1, l2, l3]) assert.ok(existsSync(f), `应生成 ${f}`);

    const s0 = readFileSync(l0, "utf8");
    const s1 = readFileSync(l1, "utf8");
    const s2 = readFileSync(l2, "utf8");
    const s3 = readFileSync(l3, "utf8");
    assert.ok(s0.length > s1.length && s1.length > s2.length && s2.length > s3.length, "l0 > l1 > l2 > l3");

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
    assert.ok(existsSync(path.join(outDir, "--tmp-proj--", `${SAMPLE_BASE}.l0.md`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: 同日按时间编号；插入更早 session 后重编号并清理旧文件", () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-test-"));
  const sessionsDir = path.join(root, "sessions");
  const subDir = path.join(sessionsDir, "--tmp-proj--");
  mkdirSync(subDir, { recursive: true });
  // 正午 UTC：任意真实时区（±12h）都落在同一本地日期
  writeFileSync(path.join(subDir, "2026-09-14T12-10-00_a.jsonl"), sessionJsonl("uuid-a", "2026-09-14T12:10:00.000Z", "alpha"));
  writeFileSync(path.join(subDir, "2026-09-14T12-20-00_b.jsonl"), sessionJsonl("uuid-b", "2026-09-14T12:20:00.000Z", "my session"));
  writeFileSync(path.join(subDir, "2026-09-14T12-30-00_c.jsonl"), sessionJsonl("uuid-c", "2026-09-14T12:30:00.000Z"));

  const d = localDate("2026-09-14T12:10:00.000Z");
  const gardenDir = path.join(root, "garden", "--tmp-proj--");
  const l2 = (base: string) => path.join(gardenDir, `${base}.l2.md`);
  try {
    execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(existsSync(l2(`${d}-001-alpha`)));
    assert.ok(existsSync(l2(`${d}-002-my_session`))); // 空格 → _
    assert.ok(existsSync(l2(`${d}-003-untitled`))); // 无名 → untitled

    // 插入更早的 session → 后面全部重编号
    writeFileSync(path.join(subDir, "2026-09-14T12-00-00_z.jsonl"), sessionJsonl("uuid-z", "2026-09-14T12:00:00.000Z", "zero"));
    const out2 = execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(existsSync(l2(`${d}-001-zero`)));
    assert.ok(existsSync(l2(`${d}-002-alpha`)));
    assert.ok(existsSync(l2(`${d}-003-my_session`)));
    assert.ok(existsSync(l2(`${d}-004-untitled`)));
    // 旧编号文件（3 session × 4 级别 = 12 个）被按 uuid 清理
    assert.ok(!existsSync(l2(`${d}-001-alpha`)), "旧编号应被清理");
    assert.ok(!existsSync(l2(`${d}-002-my_session`)), "旧编号应被清理");
    assert.ok(!existsSync(l2(`${d}-003-untitled`)), "旧编号应被清理");
    assert.ok(out2.includes("清理 12 个旧文件"), out2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: 旧式命名（uuid 文件名）按 frontmatter session_id 清理；无源孤儿保留", () => {
  const { root, sessionsDir } = setup();
  const gardenDir = path.join(root, "garden", "--tmp-proj--");
  try {
    execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(existsSync(path.join(gardenDir, `${SAMPLE_BASE}.l1.md`)));

    // 模拟旧版 garden 留下的 uuid 命名文件（frontmatter 含同一 session_id）
    const stale = path.join(gardenDir, "2026-09-14T01-00-00_test-session-uuid.l1.md");
    writeFileSync(stale, `---\nlevel: "l1"\nsession_id: "test-session-uuid"\n---\n旧内容\n`);
    // 无源孤儿：session_id 在当前 sessions 中不存在 → 保留（归档语义）
    const orphan = path.join(gardenDir, "2026-09-14T01-00-00_deadbeef.l1.md");
    writeFileSync(orphan, `---\nlevel: "l1"\nsession_id: "deadbeef"\n---\n孤儿\n`);

    // 第二次运行：全部已是最新，但 stale 仍应被清理
    const out = execFileSync(process.execPath, [CLI, sessionsDir], { encoding: "utf8" });
    assert.ok(out.includes("0 更新"), out);
    assert.ok(!existsSync(stale), "同 uuid 的旧命名文件应被清理");
    assert.ok(existsSync(orphan), "无源孤儿应保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
