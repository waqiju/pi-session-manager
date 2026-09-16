import assert from "node:assert/strict";
import * as os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSubtreeCopyText,
  COPY_SUBTREE_MAX,
  formatAge,
  formatSizeLabel,
  GardenSelectorComponent,
  isCtrlLetter,
  LineInput,
} from "../extensions/garden-selector.ts";
import type { SessionListItem } from "../src/session-list.ts";
import { buildSessionTree, flattenSessionTree } from "../src/session-tree.ts";
import { stripAnsi } from "../src/textwidth.ts";

// ---------- 测试桩 ----------

/** 颜色/样式全部恒等，断言只看纯文本 */
const stubTheme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

/** 最小按键映射（对齐 pi 0.85.1 默认：enter/escape/up/down/tab/ctrl+r/ctrl+d；
 *  app.session.new 已空无默认绑定，Ctrl+N 由组件 isCtrlN 自理，不经此 mock） */
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
  copied: string[];
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
    copied: [],
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
    copyToClipboard: (text) => {
      h.copied.push(text);
      return { ok: true };
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

test("isCtrlLetter: 三种终端编码匹配；修饰键不符/无修饰/异字母不匹配", () => {
  assert.ok(isCtrlLetter("\x0e", "n"), "legacy 控制字符");
  assert.ok(isCtrlLetter("\x1b[110;5u", "n"), "Kitty CSI-u");
  assert.ok(isCtrlLetter("\x1b[110;5:1u", "n"), "CSI-u 带 event type");
  assert.ok(isCtrlLetter("\x1b[110::110;5u", "n"), "CSI-u 带 base layout key");
  assert.ok(isCtrlLetter("\x1b[110;69u", "n"), "ctrl + Caps Lock 位（64+4+1）");
  assert.ok(isCtrlLetter("\x1b[27;5;110~", "n"), "xterm modifyOtherKeys");
  assert.ok(isCtrlLetter("\x19", "y"), "ctrl+y legacy");
  assert.ok(isCtrlLetter("\x1b[121;5u", "y"), "ctrl+y CSI-u");
  assert.ok(isCtrlLetter("\x1b[27;5;121~", "y"), "ctrl+y modifyOtherKeys");
  assert.ok(!isCtrlLetter("n", "n"), "裸字母");
  assert.ok(!isCtrlLetter("\x1b[110u", "n"), "无修饰 = 纯 n");
  assert.ok(!isCtrlLetter("\x1b[110;2u", "n"), "shift+n");
  assert.ok(!isCtrlLetter("\x1b[110;3u", "n"), "alt+n");
  assert.ok(!isCtrlLetter("\x1b[98;5u", "n"), "ctrl+b 别的键");
  assert.ok(!isCtrlLetter("\x19", "n"), "ctrl+y 不算 ctrl+n");
});

test("选择器: Ctrl+N 新建子会话（onNewChild 回调，三种编码）", async () => {
  const a = makeItem({ mdBase: "aaa", name: "父会话", modified: new Date("2026-09-14T01:00:00Z") });
  const b = makeItem({ mdBase: "bbb", name: "子会话", modified: new Date("2026-09-14T02:00:00Z") });
  // legacy \x0e / Kitty CSI-u / modifyOtherKeys 三种编码都应触发
  for (const data of ["\x0e", "\x1b[110;5u", "\x1b[27;5;110~"]) {
    const h = harness([a, b]);
    await flush();
    // b 最新排第一 → Ctrl+N 创建其子会话
    h.c.handleInput(data);
    assert.deepEqual(h.newChildren, [b.path], `编码 ${JSON.stringify(data)}`);
  }
  const h = harness([a, b]);
  await flush();
  assert.ok(plain(h.c).includes("Ctrl+N 新建子会话"), "hint 常驻");

  // 不传 onNewChild 时 Ctrl+N 不消费，回退到搜索输入
  const h2 = harness([a, b], undefined, { onNewChild: undefined });
  await flush();
  h2.c.handleInput("\x0e");
  h2.c.handleInput("\x1b[110;5u");
  assert.equal(h2.newChildren.length, 0);
  // \x0e 是 Shift Out（不可打印）、CSI-u 以 ESC 开头：LineInput 不识别 → 不崩即可
});

test("formatSizeLabel: 各量级", () => {
  assert.equal(formatSizeLabel(null), "?");
  assert.equal(formatSizeLabel(500), "500B");
  assert.equal(formatSizeLabel(8192), "8KB");
  assert.equal(formatSizeLabel(1258291), "1.2MB");
});

test("buildSubtreeCopyText: 树形 + 路径清单（~ 缩短 / untitled / size 缺失）", () => {
  const homeDir = os.homedir();
  const root = makeItem({
    mdBase: "aaa",
    name: "根会话",
    messageCount: 10,
    mdDir: path.join(homeDir, ".pi/agent/garden/--s--"),
  });
  const child = makeItem({ mdBase: "bbb", parentSessionPath: "/tmp/x/sessions/--s--/aaa.jsonl", messageCount: 5 });
  const grand = makeItem({ mdBase: "ccc", parentSessionPath: "/tmp/x/sessions/--s--/bbb.jsonl", messageCount: 2 });
  const [tree] = buildSessionTree([root, child, grand]); // child/grand 挂 root 下，唯一 root
  const flat = flattenSessionTree([tree]);
  const text = buildSubtreeCopyText(flat, (p) => (p.endsWith("aaa.l3.md") ? 8192 : null));
  const lines = text.split("\n");
  assert.equal(lines[0], "## Garden Session Subtree");
  assert.equal(lines[2], "根: 根会话 (10 msgs)");
  assert.equal(lines[3], "└─ untitled (5 msgs)", "depth-1 子节点顶格（跳过子树根槽位）");
  assert.equal(lines[4], "   └─ untitled (2 msgs)");
  assert.ok(lines[6].startsWith("文件路径（l3 = 纯问答视图"), lines[6]);
  assert.ok(lines[7].includes("~/.pi/agent/garden/--s--/aaa.l3.md  8KB  10 msgs"), lines[7]);
  assert.ok(lines[8].includes("/tmp/x/garden/--s--/bbb.l3.md  ?  5 msgs"), lines[8]);
  assert.ok(text.endsWith("\n"));
});

test("选择器: Ctrl+Y 复制子树（叶子 / 整树 / 搜索态 / 失败 / 未注入）", async () => {
  const root = makeItem({ mdBase: "aaa", name: "根会话", messageCount: 10, modified: new Date("2026-09-14T01:00:00Z") });
  const child = makeItem({
    mdBase: "bbb",
    name: "子会话",
    parentSessionPath: "/tmp/x/sessions/--s--/aaa.jsonl",
    messageCount: 5,
    modified: new Date("2026-09-14T02:00:00Z"),
  });
  const grand = makeItem({
    mdBase: "ccc",
    parentSessionPath: "/tmp/x/sessions/--s--/bbb.jsonl",
    messageCount: 2,
    modified: new Date("2026-09-14T03:00:00Z"),
  });
  const other = makeItem({ mdBase: "zzz", name: "别家", messageCount: 99, modified: new Date("2026-09-14T04:00:00Z") });

  // 叶子：默认选中 other（最新排第一）→ 只复制自身
  const h = harness([root, child, grand, other]);
  await flush();
  assert.ok(plain(h.c).includes("Ctrl+Y 复制子树"), "hint 常驻");
  h.c.handleInput("\x19"); // ctrl+y legacy
  assert.equal(h.copied.length, 1);
  assert.ok(h.copied[0].includes("根: 别家 (99 msgs)"), h.copied[0]);
  assert.ok(!h.copied[0].includes("子会话"), "叶子不连带别的树");

  // 下移到 root → Kitty CSI-u 编码复制整棵子树（3 个）
  h.c.handleInput("\x1b[B");
  h.c.handleInput("\x1b[121;5u");
  assert.equal(h.copied.length, 2);
  assert.ok(h.copied[1].includes("根: 根会话 (10 msgs)"), h.copied[1]);
  assert.ok(h.copied[1].includes("└─ 子会话 (5 msgs)"));
  assert.ok(h.copied[1].includes("untitled (2 msgs)"));
  assert.ok(!h.copied[1].includes("别家"));
  assert.ok(plain(h.c).includes("已复制 3 个 session 到剪贴板"), plain(h.c));

  // 搜索态：过滤到 root，仍复制完整后代链
  const h2 = harness([root, child, grand, other]);
  await flush();
  h2.c.handleInput("根");
  h2.c.handleInput("\x19");
  assert.equal(h2.copied.length, 1);
  assert.ok(h2.copied[0].includes("根: 根会话"), h2.copied[0]);
  assert.ok(h2.copied[0].includes("子会话"), "搜索态复制仍含后代");

  // 剪贴板失败 → error toast，不崩
  const h3 = harness([root], undefined, { copyToClipboard: () => ({ ok: false, error: "无可用剪贴板命令" }) });
  await flush();
  h3.c.handleInput("\x19");
  assert.equal(h3.copied.length, 0);
  assert.ok(plain(h3.c).includes("复制失败: 无可用剪贴板命令"), plain(h3.c));

  // 未注入 copyToClipboard → ctrl+y 不消费（落进搜索也无副作用），hint 不显示
  const h4 = harness([root], undefined, { copyToClipboard: undefined });
  await flush();
  h4.c.handleInput("\x19");
  assert.equal(h4.copied.length, 0);
  assert.ok(!plain(h4.c).includes("Ctrl+Y"));
});

test("选择器: 子树超过上限拒绝复制", async () => {
  const root = makeItem({ mdBase: "aaa", name: "大根", modified: new Date("2026-09-14T01:00:00Z") });
  const children = Array.from({ length: COPY_SUBTREE_MAX + 1 }, (_, i) =>
    makeItem({
      mdBase: `c${String(i).padStart(3, "0")}`,
      parentSessionPath: "/tmp/x/sessions/--s--/aaa.jsonl",
      modified: new Date(`2026-09-14T02:${String(i % 60).padStart(2, "0")}:00Z`),
    }),
  );
  const h = harness([root, ...children]);
  await flush();
  // root 是唯一树根，默认选中 → 子树 100+1 > 99 硬拒
  h.c.handleInput("\x19");
  assert.equal(h.copied.length, 0, "超限不复制");
  assert.ok(plain(h.c).includes(`子树过大（${COPY_SUBTREE_MAX + 2}>${COPY_SUBTREE_MAX}）`), plain(h.c));
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
