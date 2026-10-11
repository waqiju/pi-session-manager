import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyPathMerge, encodeCwd, preparePathMerge, stripProjectPrefix } from "../src/path-merge.ts";

const wsl = "/mnt/d/1_Workspace/bot_home";
const win = "D:\\1_Workspace\\bot_home";
const mac = "/Users/plato/1_Workspace/bot_home";
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "garden-merge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (kind: string, cwd: string) => path.join(root, kind, encodeCwd(cwd));
  const add = (cwd: string, id: string) => {
    fs.mkdirSync(dir("sessions", cwd), { recursive: true });
    fs.mkdirSync(dir("garden", cwd), { recursive: true });
    fs.writeFileSync(path.join(dir("sessions", cwd), `${id}.jsonl`), JSON.stringify({ type: "session", id, cwd }) + "\n");
    fs.writeFileSync(path.join(dir("garden", cwd), `${id}.l3.md`), `---\ncwd: ${JSON.stringify(cwd)}\n---\n${id}`);
  };
  return { root, dir, add };
}

test("prefixes: Windows/WSL/Mac home/volume, case sensitive, reject unsupported", () => {
  for (const cwd of [wsl, win, mac, "/Volumes/Data/1_Workspace/bot_home/"]) {
    assert.equal(stripProjectPrefix(cwd)?.key, "1_Workspace/bot_home");
  }
  assert.equal(stripProjectPrefix("/home/user/bot_home"), null);
  assert.equal(stripProjectPrefix("/Users/plato/../x"), null);
  assert.notEqual(stripProjectPrefix(mac)?.key, stripProjectPrefix(mac.toUpperCase())?.key);
});

test("current cwd only; priority WSL > Windows > Mac; merge + relative links + backups + idempotence", (t) => {
  const f = fixture(t);
  f.add(wsl, "a"); f.add(win, "b"); f.add(mac, "c");
  const other = "/mnt/d/other"; f.add(other, "other");
  f.add("D:\\other", "other-win");
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  assert.equal(plan.members.length, 3); assert.equal(plan.keeper, encodeCwd(wsl));
  const backups = applyPathMerge(plan);
  assert.equal(backups.length, 2);
  for (const kind of ["sessions", "garden"]) {
    assert.ok(!fs.lstatSync(f.dir(kind, wsl)).isSymbolicLink());
    assert.equal(fs.readlinkSync(f.dir(kind, mac)), encodeCwd(wsl));
    assert.equal(fs.readlinkSync(f.dir(kind, win)), encodeCwd(wsl));
    assert.equal(fs.readdirSync(f.dir(kind, mac)).length, 3);
    assert.ok(fs.existsSync(path.join(backups[kind === "sessions" ? 0 : 1], encodeCwd(mac))));
  }
  assert.ok(!fs.lstatSync(f.dir("sessions", other)).isSymbolicLink());
  assert.equal(preparePathMerge(mac, f.dir("sessions", mac)), null);
  // The running session's original path remains writable through its alias.
  fs.appendFileSync(path.join(f.dir("sessions", mac), "c.jsonl"), "continued\n");
  assert.match(fs.readFileSync(path.join(f.dir("sessions", wsl), "c.jsonl"), "utf8"), /continued/);
});

test("sessions same-name differences still abort without mutations", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  fs.writeFileSync(path.join(f.dir("sessions", wsl), "same.jsonl"), "one");
  fs.writeFileSync(path.join(f.dir("sessions", mac), "same.jsonl"), "two");
  assert.throws(() => preparePathMerge(mac, f.dir("sessions", mac)), /同名文件/);
  assert.ok(!fs.lstatSync(f.dir("sessions", mac)).isSymbolicLink());
});

test("garden conflicts select newest mtime, including index; ties use platform priority and warn", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(win, "b"); f.add(mac, "c");
  for (const name of ["index.md", "same.l3.md", "tie.txt"]) {
    for (const [i, cwd] of [wsl, win, mac].entries()) {
      const file = path.join(f.dir("garden", cwd), name);
      fs.writeFileSync(file, cwd);
      const time = name === "tie.txt" ? 1000 : name === "index.md" ? 1000 + i : 1002 - i;
      fs.utimesSync(file, time, time);
    }
  }
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  assert.equal(plan.roots[0].warnings.length, 0);
  assert.equal(plan.roots[1].warnings.length, 3);
  const backups = applyPathMerge(plan);
  assert.equal(fs.readFileSync(path.join(f.dir("garden", wsl), "index.md"), "utf8"), mac);
  assert.equal(fs.readFileSync(path.join(f.dir("garden", wsl), "same.l3.md"), "utf8"), wsl);
  assert.equal(fs.readFileSync(path.join(f.dir("garden", wsl), "tie.txt"), "utf8"), wsl);
  assert.equal(fs.readFileSync(path.join(backups[1], encodeCwd(win), "index.md"), "utf8"), win);
});

test("garden mtime-only changes invalidate confirmation", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  for (const cwd of [wsl, mac]) {
    const file = path.join(f.dir("garden", cwd), "index.md");
    fs.writeFileSync(file, cwd); fs.utimesSync(file, 1000, 1000);
  }
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  fs.utimesSync(path.join(f.dir("garden", mac), "index.md"), 2000, 2000);
  assert.throws(() => applyPathMerge(plan), /已变化/);
});

test("stale confirmation rejected; identical files deduplicated", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  for (const cwd of [wsl, mac]) fs.writeFileSync(path.join(f.dir("garden", cwd), "same.txt"), "same");
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  fs.writeFileSync(path.join(f.dir("garden", mac), "new.txt"), "new");
  assert.throws(() => applyPathMerge(plan), /已变化/);
  applyPathMerge(preparePathMerge(mac, f.dir("sessions", mac))!);
  assert.equal(fs.readFileSync(path.join(f.dir("garden", wsl), "same.txt"), "utf8"), "same");
});

test("missing current group is linked; Windows beats Mac; missing garden supported", (t) => {
  const f = fixture(t); f.add(win, "a");
  fs.rmSync(path.join(f.root, "garden"), { recursive: true });
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  assert.equal(plan.keeper, encodeCwd(win)); applyPathMerge(plan);
  assert.ok(fs.lstatSync(f.dir("sessions", mac)).isSymbolicLink());
  assert.ok(fs.lstatSync(f.dir("garden", mac)).isSymbolicLink());
});

test("lossy encoding cannot merge a-b with a/b; same-rank ambiguity fails closed", (t) => {
  const f = fixture(t); f.add("/mnt/d/a-b", "a"); f.add("/Users/p/a/b", "b");
  assert.equal(preparePathMerge("/mnt/d/a-b", f.dir("sessions", "/mnt/d/a-b")), null);
  f.add(wsl, "x"); f.add("/mnt/e/1_Workspace/bot_home", "y");
  assert.throws(() => preparePathMerge(wsl, f.dir("sessions", wsl)), /同优先级/);
});

test("link creation failure during commit rolls back both roots", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  const original = fs.symlinkSync;
  t.mock.method(fs, "symlinkSync", (...args: Parameters<typeof fs.symlinkSync>) => {
    if (args[1] === f.dir("garden", mac)) throw new Error("injected link failure");
    return original(...args);
  });
  assert.throws(() => applyPathMerge(plan), /injected link failure.*原目录已保留\/恢复/);
  for (const kind of ["sessions", "garden"]) {
    assert.ok(!fs.lstatSync(f.dir(kind, mac)).isSymbolicLink());
    assert.equal(fs.readdirSync(f.dir(kind, mac)).length, 1);
    assert.equal(fs.readdirSync(f.dir(kind, wsl)).length, 1);
  }
});

test(".mono metadata is excluded and deleted from backups after successful merge", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  for (const kind of ["sessions", "garden"]) {
    for (const cwd of [wsl, mac]) {
      const mono = path.join(f.dir(kind, cwd), ".mono", "nested");
      fs.mkdirSync(mono, { recursive: true });
      fs.writeFileSync(path.join(mono, "same.meta"), cwd);
    }
  }
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  // Metadata changes do not invalidate confirmation; Mono will rebuild it.
  fs.writeFileSync(path.join(f.dir("sessions", mac), ".mono", "new.meta"), "new");
  const backups = applyPathMerge(plan);
  for (const [i, kind] of ["sessions", "garden"].entries()) {
    for (const cwd of [wsl, mac]) {
      assert.ok(!fs.existsSync(path.join(f.dir(kind, cwd), ".mono")));
      assert.ok(!fs.existsSync(path.join(backups[i], encodeCwd(cwd), ".mono")));
    }
    assert.equal(fs.readdirSync(f.dir(kind, wsl)).length, 2);
  }
  assert.equal(preparePathMerge(mac, f.dir("sessions", mac)), null);
});

test(".mono survives rollback if link creation fails", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  for (const kind of ["sessions", "garden"]) {
    for (const cwd of [wsl, mac]) {
      const mono = path.join(f.dir(kind, cwd), ".mono");
      fs.mkdirSync(mono);
      fs.writeFileSync(path.join(mono, "state.meta"), cwd);
    }
  }
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  const original = fs.symlinkSync;
  t.mock.method(fs, "symlinkSync", (...args: Parameters<typeof fs.symlinkSync>) => {
    if (args[1] === f.dir("garden", mac)) throw new Error("injected link failure");
    return original(...args);
  });
  assert.throws(() => applyPathMerge(plan), /injected link failure.*原目录已保留\/恢复/);
  for (const kind of ["sessions", "garden"]) {
    for (const cwd of [wsl, mac]) {
      assert.equal(fs.readFileSync(path.join(f.dir(kind, cwd), ".mono", "state.meta"), "utf8"), cwd);
    }
  }
});

test("only .mono directories are exempt; other hidden directories and symlinks still abort", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  const hidden = path.join(f.dir("sessions", mac), ".other");
  fs.mkdirSync(hidden);
  assert.throws(() => preparePathMerge(mac, f.dir("sessions", mac)), /嵌套目录/);
  fs.rmSync(hidden, { recursive: true });
  const target = fs.mkdtempSync(path.join(f.root, "external-"));
  fs.writeFileSync(path.join(target, "keep.meta"), "keep");
  const mono = path.join(f.dir("sessions", mac), ".mono");
  fs.symlinkSync(target, mono, "dir");
  assert.throws(() => preparePathMerge(mac, f.dir("sessions", mac)), /嵌套目录或文件链接/);
  fs.unlinkSync(mono);
  fs.symlinkSync(path.join(f.dir("sessions", mac), "b.jsonl"), mono);
  assert.throws(() => preparePathMerge(mac, f.dir("sessions", mac)), /嵌套目录或文件链接/);
  assert.equal(fs.readFileSync(path.join(target, "keep.meta"), "utf8"), "keep");
});

test("nested entries abort without changing originals", (t) => {
  const f = fixture(t); f.add(wsl, "a"); f.add(mac, "b");
  const plan = preparePathMerge(mac, f.dir("sessions", mac))!;
  // Nested entries are deliberately unsupported and detected before writes.
  fs.mkdirSync(path.join(f.dir("sessions", mac), "nested"));
  assert.throws(() => applyPathMerge(plan), /嵌套目录/);
  assert.ok(!fs.lstatSync(f.dir("sessions", mac)).isSymbolicLink());
});
