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

/** env 补丁在 fn 全程有效（含 async fn 的所有 await 之后），落定后才还原 */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return await fn(); // 必须 await：否则 finally 会在 async fn 的第一个 await 处提前还原
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("withEnv: async fn 全程保持补丁，结束后还原", async () => {
  delete process.env.PI_GARDEN_TEST_PROBE;
  await withEnv({ PI_GARDEN_TEST_PROBE: "1" }, async () => {
    assert.equal(process.env.PI_GARDEN_TEST_PROBE, "1");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(process.env.PI_GARDEN_TEST_PROBE, "1", "await 之后补丁仍在（回归：finally 不得提前还原）");
  });
  assert.equal(process.env.PI_GARDEN_TEST_PROBE, undefined, "结束后已还原");
});

test("readConfig: 默认值 / 停用 / live 间隔 / 选择器全文开关 / 导出级别", () => {
  assert.deepEqual(readConfig({}), { enabled: true, liveIntervalMs: 60_000, selectorFullText: true, levels: ["l1", "l3"] });
  assert.deepEqual(readConfig({ PI_GARDEN: "0" }), { enabled: false, liveIntervalMs: 60_000, selectorFullText: true, levels: ["l1", "l3"] });
  assert.deepEqual(readConfig({ PI_GARDEN_LIVE_INTERVAL_S: "0" }), { enabled: true, liveIntervalMs: 0, selectorFullText: true, levels: ["l1", "l3"] });
  assert.deepEqual(readConfig({ PI_GARDEN_LIVE_INTERVAL_S: "2.5" }), { enabled: true, liveIntervalMs: 2500, selectorFullText: true, levels: ["l1", "l3"] });
  assert.deepEqual(readConfig({ PI_GARDEN_LIVE_INTERVAL_S: "abc" }), { enabled: true, liveIntervalMs: 0, selectorFullText: true, levels: ["l1", "l3"] });
  assert.deepEqual(readConfig({ PI_GARDEN_SELECTOR_FULLTEXT: "0" }), { enabled: true, liveIntervalMs: 60_000, selectorFullText: false, levels: ["l1", "l3"] });
  // PI_GARDEN_LEVELS：大小写不敏感、去重、保序；全部非法回退默认
  assert.deepEqual(readConfig({ PI_GARDEN_LEVELS: "l0,l2" }).levels, ["l0", "l2"]);
  assert.deepEqual(readConfig({ PI_GARDEN_LEVELS: " L3, l1 ,l3 " }).levels, ["l3", "l1"]);
  assert.deepEqual(readConfig({ PI_GARDEN_LEVELS: "l9" }).levels, ["l1", "l3"]);
  assert.deepEqual(readConfig({ PI_GARDEN_LEVELS: "" }).levels, ["l1", "l3"]);
});

test("gardenPathsFor: 只接受 pi 标准 sessions 布局", () => {
  const p = gardenPathsFor("/home/u/.pi/agent/sessions/--cwd--/s.jsonl");
  assert.deepEqual(p, { sub: "--cwd--", outRoot: "/home/u/.pi/agent/garden" });
  assert.equal(gardenPathsFor("/home/u/.pi/agent/sessions/s.jsonl"), null); // 少一层 sub
  assert.equal(gardenPathsFor("/home/u/other/--cwd--/s.jsonl"), null); // 非 sessions 目录
  assert.equal(gardenPathsFor("/home/u/.pi/agent/sessions/--cwd--/s.txt"), null); // 非 jsonl
});

const SAMPLE_BASE = "2026-09-14-001-garden_开发会话";

test("convertSessionFile: 默认导出 l1/l3；levels 参数可指定", () => {
  const { root, sessionFile } = setup();
  try {
    const res = convertSessionFile(sessionFile);
    assert.ok(res && res.written.length === 2, `expected 2 written, got ${res?.written.length}`);
    const dir = path.join(root, "garden", "--tmp-proj--");
    for (const l of ["l1", "l3"]) assert.ok(existsSync(path.join(dir, `${SAMPLE_BASE}.${l}.md`)), `missing .${l}.md`);
    for (const l of ["l0", "l2"]) assert.ok(!existsSync(path.join(dir, `${SAMPLE_BASE}.${l}.md`)), `默认不应生成 .${l}.md`);
    // 显式指定默认不导出的级别
    const res2 = convertSessionFile(sessionFile, ["l0"]);
    assert.deepEqual(res2?.written, ["l0"]);
    assert.ok(existsSync(path.join(dir, `${SAMPLE_BASE}.l0.md`)));
    assert.equal(convertSessionFile(path.join(root, "sessions", "s.jsonl")), null); // 布局不符
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展: session_shutdown / session_compact / session_start / session_info_changed 触发转换", async () => {
  const { root, sessionFile } = setup();
  try {
    await withEnv({ PI_GARDEN: undefined, PI_GARDEN_LIVE_INTERVAL_S: "0" }, async () => {
      const { pi, handlers } = mockPi();
      garden(pi as any);
      const logs: string[] = [];
      const ctx = mockCtx(sessionFile, logs);
      const l1 = path.join(root, "garden", "--tmp-proj--", `${SAMPLE_BASE}.l1.md`);
      {
        await handlers.get("session_shutdown")!({}, ctx);
        assert.ok(existsSync(l1), "shutdown 应触发转换");

        unlinkSync(l1);
        await handlers.get("session_compact")!({}, ctx);
        assert.ok(existsSync(l1), "compact 应触发转换");

        unlinkSync(l1);
        await handlers.get("session_start")!({}, ctx);
        assert.ok(existsSync(l1), "start 应触发转换");

        unlinkSync(l1);
        await handlers.get("session_info_changed")!({}, ctx);
        assert.ok(existsSync(l1), "info_changed 应触发转换");

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
      const l1 = path.join(root, "garden", "--tmp-proj--", `${SAMPLE_BASE}.l1.md`);
      const settle = () => handlers.get("agent_settled")!({}, ctx);

      await settle(); // 首次：转换
      assert.ok(existsSync(l1));

      unlinkSync(l1);
      now += 10_000; // +10s < 60s：防抖跳过
      await settle();
      assert.ok(!existsSync(l1), "间隔内不应重复转换");

      now += 61_000; // +61s > 60s：再次转换
      await settle();
      assert.ok(existsSync(l1));
    });
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展: PI_GARDEN=0 完全停用", async () => {
  await withEnv({ PI_GARDEN: "0" }, async () => {
    const { pi, handlers, commands } = mockPi();
    garden(pi as any);
    assert.equal(handlers.size, 0);
    assert.equal(commands.size, 0);
  });
});

test("扩展: /gardener-output 与 /gardener-output all 命令", async () => {
  const { root, sessionFile } = setup();
  try {
    await withEnv({}, async () => {
      const { pi, commands } = mockPi();
      garden(pi as any);
      const logs: string[] = [];
      const ctx = mockCtx(sessionFile, logs);
      const cmd = commands.get("gardener-output")!;
      await cmd.handler("", ctx);
      const last = logs.at(-1)!;
      assert.ok(last.includes("已更新"), last);
      assert.ok(last.includes(".l1.md") && last.includes(".l3.md"), last);

      await cmd.handler("", ctx); // 第二次：增量跳过
      assert.ok(logs.at(-1)?.includes("已是最新"), logs.join());

      await cmd.handler("all", ctx);
      assert.ok(logs.at(-1)?.includes("garden all: 1 个 session"), logs.join());
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展: /gardener-open 转换后打开最高级别 + 级别参数校验", async () => {
  const { root, sessionFile } = setup();
  try {
    await withEnv({ PI_GARDEN_OPEN_CMD: "true" }, async () => {
      const { pi, commands } = mockPi();
      garden(pi as any);
      const logs: string[] = [];
      const ctx = mockCtx(sessionFile, logs);
      const cmd = commands.get("gardener-open")!;

      await cmd.handler("l9", ctx); // 非法级别
      assert.ok(logs.at(-1)?.includes("未知级别"), logs.join());

      await cmd.handler("", ctx); // 无产物 → 先转换 → 打开最高级别（l3 现在存在）
      assert.ok(logs.at(-1)?.includes("已打开"), logs.join());
      assert.ok(logs.at(-1)?.includes(".l3.md"), logs.join());

      await cmd.handler("l0", ctx); // 指定默认不导出的级别：按需即时生成再打开
      assert.ok(logs.at(-1)?.includes(".l0.md"), logs.join());

      await cmd.handler("l3", ctx); // 指定级别存在
      assert.ok(logs.at(-1)?.includes(".l3.md"), logs.join());

      // ephemeral session
      await cmd.handler("", mockCtx(undefined, logs));
      assert.ok(logs.at(-1)?.includes("无 session 文件"), logs.join());
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展: /garden 选择器在无 UI 模式下告警且不加载 pi 包", async () => {
  const { root, sessionFile } = setup();
  try {
    await withEnv({}, async () => {
      const { pi, commands } = mockPi();
      garden(pi as any);
      const logs: string[] = [];
      const ctx = mockCtx(sessionFile, logs);
      ctx.hasUI = false; // print 模式：guard 生效则静默返回；若误走到动态 import pi 包会直接拋错
      await commands.get("garden")!.handler("", ctx);
      assert.equal(logs.length, 0, "无 UI 时静默返回（不加载 pi 包）");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
