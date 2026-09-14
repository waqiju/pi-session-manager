import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import garden, { convertSessionFile, gardenPathsFor, readConfig } from "../extensions/garden.ts";
import { buildSampleJsonl } from "./sample.ts";

type Handler = (event: any, ctx: any) => Promise<unknown>;

function mockPi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    on: (ev: string, h: Handler) => void handlers.set(ev, h),
    registerCommand: (name: string, opts: any) => void commands.set(name, opts),
  };
  return { pi, handlers, commands };
}

function mockCtx(file: string | undefined, logs: string[]) {
  return {
    sessionManager: { getSessionFile: () => file },
    hasUI: true,
    ui: { notify: (m: string, l: string) => logs.push(`${l}:${m}`) },
  };
}

/** tmp 下搭 pi 标准布局 sessions/<sub>/xxx.jsonl */
function setup(): { root: string; sessionFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), "garden-ext-test-"));
  const sub = path.join(root, "sessions", "--tmp-proj--");
  mkdirSync(sub, { recursive: true });
  const sessionFile = path.join(sub, "2026-09-14T01-00-00_test.jsonl");
  writeFileSync(sessionFile, buildSampleJsonl());
  return { root, sessionFile };
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("readConfig: 默认值 / 停用 / live 间隔", () => {
  assert.deepEqual(readConfig({}), { enabled: true, liveIntervalMs: 60_000 });
  assert.deepEqual(readConfig({ PI_GARDEN: "0" }), { enabled: false, liveIntervalMs: 60_000 });
  assert.deepEqual(readConfig({ PI_GARDEN_LIVE_INTERVAL_S: "0" }), { enabled: true, liveIntervalMs: 0 });
  assert.deepEqual(readConfig({ PI_GARDEN_LIVE_INTERVAL_S: "2.5" }), { enabled: true, liveIntervalMs: 2500 });
  assert.deepEqual(readConfig({ PI_GARDEN_LIVE_INTERVAL_S: "abc" }), { enabled: true, liveIntervalMs: 0 });
});

test("gardenPathsFor: 只接受 pi 标准 sessions 布局", () => {
  const p = gardenPathsFor("/home/u/.pi/agent/sessions/--cwd--/s.jsonl");
  assert.deepEqual(p, { sub: "--cwd--", outRoot: "/home/u/.pi/agent/garden" });
  assert.equal(gardenPathsFor("/home/u/.pi/agent/sessions/s.jsonl"), null); // 少一层 sub
  assert.equal(gardenPathsFor("/home/u/other/--cwd--/s.jsonl"), null); // 非 sessions 目录
  assert.equal(gardenPathsFor("/home/u/.pi/agent/sessions/--cwd--/s.txt"), null); // 非 jsonl
});

test("convertSessionFile: 生成三级输出", () => {
  const { root, sessionFile } = setup();
  try {
    const res = convertSessionFile(sessionFile);
    assert.ok(res && res.written.length === 3);
    const dir = path.join(root, "garden", "--tmp-proj--");
    for (const l of ["l0", "l1", "l2"]) assert.ok(existsSync(path.join(dir, `2026-09-14T01-00-00_test.${l}.md`)));
    assert.equal(convertSessionFile(path.join(root, "sessions", "s.jsonl")), null); // 布局不符
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展: session_shutdown / session_compact / session_start 触发转换", async () => {
  const { root, sessionFile } = setup();
  try {
    await withEnv({ PI_GARDEN: undefined, PI_GARDEN_LIVE_INTERVAL_S: "0" }, async () => {
      const { pi, handlers } = mockPi();
      garden(pi as any);
      const logs: string[] = [];
      const ctx = mockCtx(sessionFile, logs);
      const l2 = path.join(root, "garden", "--tmp-proj--", "2026-09-14T01-00-00_test.l2.md");
      {
        await handlers.get("session_shutdown")!({}, ctx);
        assert.ok(existsSync(l2), "shutdown 应触发转换");

        unlinkSync(l2);
        await handlers.get("session_compact")!({}, ctx);
        assert.ok(existsSync(l2), "compact 应触发转换");

        unlinkSync(l2);
        await handlers.get("session_start")!({}, ctx);
        assert.ok(existsSync(l2), "start 应触发转换");

        // ephemeral session：无文件，静默不抛错
        await handlers.get("session_shutdown")!({}, mockCtx(undefined, logs));
        assert.equal(logs.length, 0, "成功路径不打扰用户");
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展: agent_settled live 防抖", async () => {
  const { root, sessionFile } = setup();
  const realNow = Date.now;
  let now = 1_000_000_000_000;
  Date.now = () => now;
  try {
    await withEnv({ PI_GARDEN_LIVE_INTERVAL_S: "60" }, async () => {
      const { pi, handlers } = mockPi();
      garden(pi as any);
      const ctx = mockCtx(sessionFile, []);
      const l2 = path.join(root, "garden", "--tmp-proj--", "2026-09-14T01-00-00_test.l2.md");
      const settle = () => handlers.get("agent_settled")!({}, ctx);

      await settle(); // 首次：转换
      assert.ok(existsSync(l2));

      unlinkSync(l2);
      now += 10_000; // +10s < 60s：防抖跳过
      await settle();
      assert.ok(!existsSync(l2), "间隔内不应重复转换");

      now += 61_000; // +61s > 60s：再次转换
      await settle();
      assert.ok(existsSync(l2));
    });
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展: PI_GARDEN=0 完全停用", () => {
  withEnv({ PI_GARDEN: "0" }, () => {
    const { pi, handlers, commands } = mockPi();
    garden(pi as any);
    assert.equal(handlers.size, 0);
    assert.equal(commands.size, 0);
  });
});

test("扩展: /garden 与 /garden all 命令", async () => {
  const { root, sessionFile } = setup();
  try {
    await withEnv({}, async () => {
      const { pi, commands } = mockPi();
      garden(pi as any);
      const logs: string[] = [];
      const ctx = mockCtx(sessionFile, logs);
      const cmd = commands.get("garden")!;
      await cmd.handler("", ctx);
      assert.ok(logs.at(-1)?.includes("已更新"), logs.join());

      await cmd.handler("", ctx); // 第二次：增量跳过
      assert.ok(logs.at(-1)?.includes("已是最新"), logs.join());

      await cmd.handler("all", ctx);
      assert.ok(logs.at(-1)?.includes("garden all: 1 个 session"), logs.join());
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
