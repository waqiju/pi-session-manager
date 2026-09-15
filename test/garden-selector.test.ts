import assert from "node:assert/strict";
import { test } from "node:test";
import { GardenSelectorComponent, LineInput, formatAge } from "../extensions/garden-selector.ts";
import type { SessionListItem } from "../src/session-list.ts";
import { stripAnsi } from "../src/textwidth.ts";

// ---------- 测试桩 ----------

/** 颜色/样式全部恒等，断言只看纯文本 */
const stubTheme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

/** 最小按键映射（对齐 pi 默认：enter/escape/up/down/tab/ctrl+r/ctrl+d） */
const KEY_MAP: Record<string, string> = {
  "\r": "tui.select.confirm",
  "\x1b": "tui.select.cancel",
  "\x1b[A": "tui.select.up",
  "\x1b[B": "tui.select.down",
  "\x1b[5~": "tui.select.pageUp",
  "\x1b[6~": "tui.select.pageDown",
  "\t": "tui.input.tab",
  "\x12": "app.session.rename",
  "\x04": "app.session.delete",
  "\x0e": "app.session.new",
};
const stubKeybindings = {
  matches: (data: string, action: string) => KEY_MAP[data] === action,
};

let seq = 0;
function makeItem(over: Partial<SessionListItem> & { mdBase: string }): SessionListItem {
  const n = ++seq;
  return {
    path: `/tmp/x/sessions/--s--/${over.mdBase}.jsonl`,
    id: `uuid-${n}`,
    cwd: "/tmp/proj",
    created: new Date("2026-09-14T01:00:00Z"),
    modified: new Date("2026-09-14T01:00:00Z"),
    messageCount: n,
    firstMessage: `消息${n}`,
    allMessagesText: "",
    mdDir: "/tmp/x/garden/--s--",
    ...over,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

interface Harness {
  c: GardenSelectorComponent;
  selected: string[];
  cancelled: { n: number };
  renamed: [string, string][];
  deleted: string[];
  newChildren: string[];
  loadCounts: { current: number; all: number };
}

function harness(
  items: SessionListItem[],
  allItems?: SessionListItem[],
  over: Record<string, unknown> = {},
): Harness {
  const h: Harness = {
    c: undefined as unknown as GardenSelectorComponent,
    selected: [],
    cancelled: { n: 0 },
    renamed: [],
    deleted: [],
    newChildren: [],
    loadCounts: { current: 0, all: 0 },
  };
  h.c = new GardenSelectorComponent({
    theme: stubTheme,
    keybindings: stubKeybindings,
    requestRender: () => {},
    loadCurrent: async () => {
      h.loadCounts.current++;
      return items;
    },
    loadAll: async () => {
      h.loadCounts.all++;
      return allItems ?? items;
    },
    onSelect: (p) => h.selected.push(p),
    onCancel: () => h.cancelled.n++,
    renameSession: async (item, name) => {
      h.renamed.push([item.path, name]);
      return undefined;
    },
    deleteSession: async (item) => {
      h.deleted.push(item.path);
      return { ok: true };
    },
    onNewChild: (item) => {
      h.newChildren.push(item.path);
    },
    ...over,
  });
  return h;
}

/** 渲染为纯文本（剥 ANSI），便于断言 */
function plain(c: GardenSelectorComponent, width = 100): string {
  return c
    .render(width)
    .map((l) => stripAnsi(l))
    .join("\n");
}

// ---------- LineInput ----------

test("LineInput: 插入/退格/光标移动/ctrl+u/粘贴换行变空格", () => {
  const input = new LineInput();
  input.handleInput("hello");
  input.handleInput("\x1b[D"); // left
  input.handleInput("\x1b[D");
  input.handleInput("X");
  assert.equal(input.getValue(), "helXlo");
  input.handleInput("\x7f"); // backspace 删 X
  assert.equal(input.getValue(), "hello");
  input.handleInput("\x1b[H"); // home
  input.handleInput("\x7f"); // 行首退格无副作用
  assert.equal(input.getValue(), "hello");
  input.handleInput("\x1b[F"); // end（ctrl+u 只删光标前）
  input.handleInput("\x15"); // ctrl+u
  assert.equal(input.getValue(), "");
  input.handleInput("line1\r\nline2"); // 粘贴
  assert.equal(input.getValue(), "line1 line2");
  input.handleInput("\x17"); // ctrl+w 删词
  assert.equal(input.getValue(), "line1 ");
  // 不识别的 escape 序列不消费
  assert.equal(input.handleInput("\x1b[1;5D"), false);
});

// ---------- 组件 ----------

test("选择器: 加载后渲染 fork 树（缩进/分支符）", async () => {
  const a = makeItem({ mdBase: "aaa", name: "父会话", modified: new Date("2026-09-14T01:00:00Z") });
  const b = makeItem({ mdBase: "bbb", name: "子会话", parentSessionPath: "/tmp/x/sessions/--s--/aaa.jsonl", modified: new Date("2026-09-14T02:00:00Z") });
  const h = harness([a, b]);
  await flush();
  const out = plain(h.c);
  assert.ok(out.includes("garden Sessions (Current Folder)"), out);
  assert.ok(out.includes("父会话"), out);
  assert.ok(out.includes("└─ 子会话"), `fork 子节点带分支符:\n${out}`);
  assert.equal(h.loadCounts.current, 1);
  assert.equal(h.loadCounts.all, 0, "all scope 未切换前不加载");
});

test("选择器: 上下移动 + Enter 选中；Esc 取消", async () => {
  const a = makeItem({ mdBase: "aaa", modified: new Date("2026-09-14T01:00:00Z") });
  const b = makeItem({ mdBase: "bbb", modified: new Date("2026-09-14T02:00:00Z") });
  const h = harness([a, b]);
  await flush();
  h.c.handleInput("\x1b[B"); // down：b 最新排第一 → 移动到 a
  h.c.handleInput("\r");
  assert.deepEqual(h.selected, [a.path]);

  const h2 = harness([a, b]);
  await flush();
  h2.c.handleInput("\x1b");
  assert.equal(h2.cancelled.n, 1);
  assert.equal(h2.selected.length, 0);
});

test("选择器: 搜索过滤 + 清空恢复树", async () => {
  const a = makeItem({ mdBase: "aaa", name: "garden 开发" });
  const b = makeItem({ mdBase: "bbb", name: "别的话题" });
  const h = harness([a, b]);
  await flush();
  h.c.handleInput("g");
  h.c.handleInput("a");
  h.c.handleInput("r");
  let out = plain(h.c);
  assert.ok(out.includes("garden 开发"), out);
  assert.ok(!out.includes("别的话题"), out);
  for (let i = 0; i < 3; i++) h.c.handleInput("\x7f"); // 清空
  out = plain(h.c);
  assert.ok(out.includes("别的话题"), "清空后恢复完整树");
});

test("选择器: Tab 切 scope（all 懒加载 + 二次切换走缓存）", async () => {
  const cur = [makeItem({ mdBase: "aaa", name: "当前项目" })];
  const all = [
    makeItem({ mdBase: "aaa", name: "当前项目" }),
    makeItem({ mdBase: "zzz", name: "别的项目", cwd: "/tmp/other" }),
  ];
  const h = harness(cur, all);
  await flush();
  h.c.handleInput("\t");
  await flush();
  let out = plain(h.c);
  assert.equal(h.loadCounts.all, 1);
  assert.ok(out.includes("garden Sessions (All)"), out);
  assert.ok(out.includes("别的项目"), out);
  assert.ok(out.includes("/tmp/other"), "all scope 显示 cwd");
  h.c.handleInput("\t"); // 切回 current
  h.c.handleInput("\t"); // 再切 all：走缓存
  await flush();
  assert.equal(h.loadCounts.all, 1, "二次切换不重复加载");
  out = plain(h.c);
  assert.ok(out.includes("别的项目"), out);
});

test("选择器: rename 流程（ctrl+r → 输入 → enter 回写 name）", async () => {
  const a = makeItem({ mdBase: "aaa", name: "旧名" });
  const h = harness([a]);
  await flush();
  h.c.handleInput("\x12"); // ctrl+r
  assert.ok(plain(h.c).includes("Rename Session"));
  h.c.handleInput("\x15"); // 清空预填
  h.c.handleInput("新名字");
  h.c.handleInput("\r");
  await flush();
  assert.deepEqual(h.renamed, [[a.path, "新名字"]]);
  assert.equal(a.name, "新名字", "内存 item 同步更新");
  assert.ok(plain(h.c).includes("新名字"));
});

test("选择器: 删除流程（ctrl+d → enter 确认 → 列表移除）；当前 session 禁止删除", async () => {
  const a = makeItem({ mdBase: "aaa", name: "要删除的", modified: new Date("2026-09-14T01:00:00Z") });
  const cur = makeItem({ mdBase: "cur", name: "当前会话", modified: new Date("2026-09-15T01:00:00Z") });
  const h = harness([cur, a], undefined, { currentFilePath: cur.path });
  await flush();
  // cur 最新排第一 → 默认选中 cur：禁止删除
  h.c.handleInput("\x04");
  assert.ok(plain(h.c).includes("不能删除当前活跃 session"));
  assert.equal(h.deleted.length, 0);
  // 移到 a 并删除
  h.c.handleInput("\x1b[B");
  h.c.handleInput("\x04");
  assert.ok(plain(h.c).includes("Delete session?"), "确认提示");
  h.c.handleInput("\r");
  await flush();
  assert.deepEqual(h.deleted, [a.path]);
  assert.ok(!plain(h.c).includes("要删除的"), "删除后从列表移除");
});

test("选择器: Ctrl+N 新建子会话（onNewChild 回调）", async () => {
  const a = makeItem({ mdBase: "aaa", name: "父会话", modified: new Date("2026-09-14T01:00:00Z") });
  const b = makeItem({ mdBase: "bbb", name: "子会话", modified: new Date("2026-09-14T02:00:00Z") });
  const h = harness([a, b]);
  await flush();
  // b 最新排第一 → Ctrl+N 创建其子会话
  h.c.handleInput("\x0e");
  assert.deepEqual(h.newChildren, [b.path]);
  assert.ok(plain(h.c).includes("Ctrl+N 新建子会话"), "hint 常驻");

  // 不传 onNewChild 时 Ctrl+N 不消费，回退到搜索输入
  const h2 = harness([a, b], undefined, { onNewChild: undefined });
  await flush();
  h2.c.handleInput("\x0e");
  assert.equal(h2.newChildren.length, 0);
  // \x0e 是 Shift Out（不可打印）：LineInput 不识别 → 不崩即可
});

test("选择器: 空目录提示回填命令；加载失败进状态栏", async () => {
  const h = harness([]);
  await flush();
  assert.ok(plain(h.c).includes("/gardener-output all"), plain(h.c));

  const h2 = harness([], undefined, {
    loadCurrent: async () => {
      throw new Error("磁盘炸了");
    },
  });
  await flush();
  assert.ok(plain(h2.c).includes("磁盘炸了"), plain(h2.c));
});

test("formatAge: 各量级", () => {
  const now = Date.now();
  assert.equal(formatAge(new Date(now - 30_000)), "now");
  assert.equal(formatAge(new Date(now - 5 * 60_000)), "5m");
  assert.equal(formatAge(new Date(now - 3 * 3600_000)), "3h");
  assert.equal(formatAge(new Date(now - 2 * 86400_000)), "2d");
  assert.equal(formatAge(new Date(now - 14 * 86400_000)), "2w");
  assert.equal(formatAge(new Date(now - 60 * 86400_000)), "2mo");
  assert.equal(formatAge(new Date(now - 400 * 86400_000)), "1y");
});
