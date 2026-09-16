import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import garden, { convertSessionFile, gardenPathsFor, readConfig } from "../extensions/garden.ts";
import { collectJobs, convertGroup, prepareGroup, processFile } from "../src/cli.ts";
import { localDate } from "../src/naming.ts";
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

/** 最小 session fixture：header + 可选 session_info + 一条 user 消息 */
function sess(id: string, timestamp: string, name?: string): string {
  const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id, timestamp, cwd: "/tmp/proj" }];
  if (name !== undefined) lines.push({ type: "session_info", id: `${id}-n`, parentId: null, timestamp, name });
  lines.push({ type: "message", id: `${id}-m`, parentId: null, timestamp, message: { role: "user", content: `hi from ${id}`, timestamp: 1 } });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** 读输出文件的 frontmatter session_id */
function ownerOf(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8").match(/^session_id: "([^"]*)"$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

test("convertSessionFile: live 转换编号撞车避让（Ctrl+N 顶掉兄弟 session 的回归）", () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-ext-test-"));
  const sub = path.join(root, "sessions", "--tmp-proj--");
  mkdirSync(sub, { recursive: true });
  const gardenDir = path.join(root, "garden", "--tmp-proj--");
  // 正午 UTC：任意真实时区都落在同一本地日期；全未命名（slug 同为 untitled，最坏撞车情形）
  const a = path.join(sub, "2026-09-15T12-10-00_a.jsonl");
  const b = path.join(sub, "2026-09-15T12-20-00_b.jsonl");
  const d = localDate("2026-09-15T12:10:00.000Z");
  const l1 = (n: number) => path.join(gardenDir, `${d}-${String(n).padStart(3, "0")}-untitled.l1.md`);
  try {
    writeFileSync(a, sess("aaa", "2026-09-15T12:10:00.000Z"));
    writeFileSync(b, sess("bbb", "2026-09-15T12:20:00.000Z"));
    // 全量组转换：a=001, b=002
    convertGroup(collectJobs(path.join(root, "sessions")).jobs, gardenDir, ["l1"], () => {});
    assert.equal(ownerOf(l1(1)), "aaa");
    assert.equal(ownerOf(l1(2)), "bbb");

    // live 转换 b（单 session 组算出 001）→ 避让到 002（自己）→ 幂等跳过，不碰 a 的文件
    const r1 = convertSessionFile(b, ["l1"]);
    assert.equal(r1?.base, `${d}-002-untitled`);
    assert.equal(ownerOf(l1(1)), "aaa", "a 的文件不得被动");

    // Ctrl+N 场景：新 session c（当日更晚）live 转换 → 避让到 003，a/b 文件不动
    const c = path.join(sub, "2026-09-15T12-30-00_c.jsonl");
    writeFileSync(c, sess("ccc", "2026-09-15T12:30:00.000Z"));
    const r2 = convertSessionFile(c, ["l1"]);
    assert.equal(r2?.base, `${d}-003-untitled`);
    assert.equal(ownerOf(l1(1)), "aaa", "回归：node11 不得被 node-new 顶掉");
    assert.equal(ownerOf(l1(2)), "bbb");
    assert.equal(ownerOf(l1(3)), "ccc");

    // 模拟旧版 bug 的撞车现场：c 的内容被写进 a 的 001 文件（a 的 md 被毁）
    const cPrep = prepareGroup([{ src: c, sub: "--tmp-proj--" }], () => {})[0];
    processFile({ ...cPrep, base: `${d}-001-untitled` }, gardenDir, ["l1"]);
    assert.equal(ownerOf(l1(1)), "ccc", "撞车构造成功");

    // 单遍全量组转换自愈：isUpToDate 的 session 校验识破“已最新”→ a 重写 001；
    // removeStaleOutputs 复核归属 → 不误删 a 刚重写的 001；c 归位 003
    const { results } = convertGroup(collectJobs(path.join(root, "sessions")).jobs, gardenDir, ["l1"], () => {});
    assert.equal(ownerOf(l1(1)), "aaa", "单遍全量后 a 恢复 001");
    assert.equal(ownerOf(l1(2)), "bbb");
    assert.equal(ownerOf(l1(3)), "ccc");
    assert.ok(results.every((r) => !r.error), "无失败项");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("扩展: /gardener-output all 按子目录分组编号（多项目同日不互占序号）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-ext-test-"));
  const sessionsDir = path.join(root, "sessions");
  // 两个项目目录，各一个同日 session → 各自应拿自己目录的 001（编号是目录内属性）
  mkdirSync(path.join(sessionsDir, "--proj-a--"), { recursive: true });
  mkdirSync(path.join(sessionsDir, "--proj-b--"), { recursive: true });
  const cur = path.join(sessionsDir, "--proj-a--", "2026-09-15T12-00-00_a.jsonl");
  writeFileSync(cur, sess("aaa", "2026-09-15T12:00:00.000Z", "甲项目"));
  writeFileSync(path.join(sessionsDir, "--proj-b--", "2026-09-15T12-10-00_b.jsonl"), sess("bbb", "2026-09-15T12:10:00.000Z", "乙项目"));
  const d = localDate("2026-09-15T12:00:00.000Z");
  try {
    await withEnv({}, async () => {
      const { pi, commands } = mockPi();
      garden(pi as any);
      const logs: string[] = [];
      const ctx = mockCtx(cur, logs);
      await commands.get("gardener-output")!.handler("all", ctx);
      assert.ok(logs.at(-1)?.includes("garden all: 2 个 session"), logs.join());
      const ga = path.join(root, "garden", "--proj-a--");
      const gb = path.join(root, "garden", "--proj-b--");
      assert.ok(existsSync(path.join(ga, `${d}-001-甲项目.l1.md`)), "proj-a 自己的 001");
      assert.ok(existsSync(path.join(gb, `${d}-001-乙项目.l1.md`)), "proj-b 自己的 001（不被 proj-a 占号）");
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
