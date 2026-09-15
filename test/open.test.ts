import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildOpenCommand, detectPlatform, isGardenLevel, openFile, pickHighestLevelFile } from "../src/open.ts";

test("pickHighestLevelFile: 取存在的最高级别；可指定级别", () => {
  const root = mkdtempSync(path.join(tmpdir(), "garden-open-test-"));
  try {
    const dir = path.join(root, "garden", "--s--");
    mkdirSync(dir, { recursive: true });
    assert.equal(pickHighestLevelFile(dir, "a"), null, "无文件 → null");

    writeFileSync(path.join(dir, "a.l0.md"), "");
    writeFileSync(path.join(dir, "a.l2.md"), "");
    assert.ok(pickHighestLevelFile(dir, "a")!.endsWith("a.l2.md"), "l3 缺失 → l2");

    writeFileSync(path.join(dir, "a.l3.md"), "");
    assert.ok(pickHighestLevelFile(dir, "a")!.endsWith("a.l3.md"), "有 l3 优先 l3");

    assert.ok(pickHighestLevelFile(dir, "a", "l0")!.endsWith("a.l0.md"), "指定级别优先");
    assert.equal(pickHighestLevelFile(dir, "a", "l1"), null, "指定的级别不存在 → null（不回退）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectPlatform: win32 / darwin / wsl / linux", () => {
  assert.equal(detectPlatform({}, "win32", ""), "win32");
  assert.equal(detectPlatform({}, "darwin", ""), "darwin");
  assert.equal(detectPlatform({ WSL_DISTRO_NAME: "Ubuntu" }, "linux", ""), "wsl");
  assert.equal(detectPlatform({ WSL_INTEROP: "/run/WSL" }, "linux", ""), "wsl");
  assert.equal(detectPlatform({}, "linux", "5.15.90.1-microsoft-standard-WSL2"), "wsl");
  assert.equal(detectPlatform({}, "linux", "6.8.0-generic"), "linux");
});

test("buildOpenCommand: 各平台 + PI_GARDEN_OPEN_CMD 覆盖", () => {
  const wsl = buildOpenCommand("/home/u/f.md", "wsl", {});
  assert.deepEqual(wsl, { cmd: "cmd.exe", args: ["/c", "start", "", "/home/u/f.md"], translatePath: true });

  assert.deepEqual(buildOpenCommand("/f.md", "linux", {}), { cmd: "xdg-open", args: ["/f.md"] });
  assert.deepEqual(buildOpenCommand("/f.md", "darwin", {}), { cmd: "open", args: ["/f.md"] });
  assert.deepEqual(buildOpenCommand("C:\\f.md", "win32", {}), {
    cmd: "cmd.exe",
    args: ["/c", "start", "", "C:\\f.md"],
  });

  const appended = buildOpenCommand("/f.md", "linux", { PI_GARDEN_OPEN_CMD: "my-browser --new-tab" });
  assert.deepEqual(appended, { cmd: "my-browser", args: ["--new-tab", "/f.md"] });

  const placeholder = buildOpenCommand("/f.md", "linux", { PI_GARDEN_OPEN_CMD: "open.sh --target {file}" });
  assert.deepEqual(placeholder, { cmd: "open.sh", args: ["--target", "/f.md"] });
});

test("isGardenLevel", () => {
  assert.ok(isGardenLevel("l0") && isGardenLevel("l3"));
  assert.ok(!isGardenLevel("l4") && !isGardenLevel(""));
});

test("openFile: 自定义命令真实 spawn；不存在的命令报错", async () => {
  const ok = await openFile("/tmp/whatever.md", { PI_GARDEN_OPEN_CMD: "true" });
  assert.ok(ok.ok, ok.detail);

  const bad = await openFile("/tmp/whatever.md", { PI_GARDEN_OPEN_CMD: "garden-nonexistent-cmd-xyz" });
  assert.ok(!bad.ok);
  assert.ok(bad.detail.includes("garden-nonexistent-cmd-xyz"));
});
