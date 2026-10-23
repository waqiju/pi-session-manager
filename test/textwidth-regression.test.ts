import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GardenSelectorComponent, LineInput } from "../extensions/garden-selector.ts";
import { nodeLabel } from "../src/format.ts";
import { stripAnsi, truncateToWidth, visibleWidth } from "../src/textwidth.ts";

const samples: [string, number][] = [["⚡", 2], ["🦄", 2], ["🗂️", 2], ["e\u0301", 1], ["👨‍👩‍👧‍👦", 2], ["🇨🇳", 2], ["中", 2]];
test("vendored widths: explicit Unicode expectations and intact truncation", () => {
  for (const [text, width] of samples) {
    assert.equal(visibleWidth(text), width, text);
    assert.equal(truncateToWidth(text + "abc", width, ""), text);
    assert.equal(truncateToWidth(text, width - 1, ""), "");
  }
  assert.equal(truncateToWidth("abc", 0), "");
  assert.equal(truncateToWidth("abc", -1), "");
  assert.equal(truncateToWidth("abcdef", 1, "..."), ".");
  const linked = "\x1b]8;;https://example.com\x07\x1b[31m⚡abc\x1b[0m\x1b]8;;\x07";
  const clipped = truncateToWidth(linked, 3);
  assert.equal(stripAnsi(clipped), "⚡…");
  assert.ok(clipped.includes("\x1b]8;;\x07"));
  assert.equal(visibleWidth(clipped), 3);
});

test("redacted real 253-column crash line fits its 252-column budget", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/garden-width-crash.json", import.meta.url), "utf8"));
  assert.equal(visibleWidth(fixture.line), 253);
  assert.equal(visibleWidth(truncateToWidth(fixture.line, fixture.width, "")), 252);
});

test("CLI labels preserve column budgets without adding terminal escapes", () => {
  assert.equal(nodeLabel({ name: "⚡".repeat(30) } as any), "⚡".repeat(23) + "…");
  assert.equal(nodeLabel({ firstMessage: "👨‍👩‍👧‍👦".repeat(30) } as any), '"' + "👨‍👩‍👧‍👦".repeat(17) + '…"');
});

test("input scrolls to cursor and edits whole graphemes", () => {
  const input = new LineInput();
  input.setValue("x".repeat(60) + "END");
  const rendered = input.render(20, "❯ ");
  assert.ok(stripAnsi(rendered).endsWith("END "));
  assert.ok(rendered.includes("\x1b_pi:c\x07\x1b[7m \x1b[27m"));
  for (const [sample] of samples) {
    input.setValue(sample.repeat(20));
    for (const width of [0, 1, 2, 3, 4, 10, 20, 252]) {
      assert.ok(visibleWidth(input.render(width, "❯ ")) <= width);
    }
    input.setValue(sample);
    input.handleInput("\x7f");
    assert.equal(input.getValue(), "");
  }
  input.setValue("e"); input.handleInput("\u0301"); input.handleInput("\x7f");
  assert.equal(input.getValue(), "");
});

test("all selector states fit narrow and resized terminals with Unicode and ANSI", async () => {
  const item = { path: "/tmp/session.jsonl", id: "1", mdBase: "one", cwd: "/tmp/⚡", created: new Date(), modified: new Date(), messageCount: 26, firstMessage: "现在是跑完，会在 jenkins console 里打印结果。通过 cooloo 发送 === ⚡ 🦄 " + "结果".repeat(150), allMessagesText: "", mdDir: "/tmp" };
  const c = new GardenSelectorComponent({
    theme: { fg: (_c, s) => `\x1b[31m${s}\x1b[39m`, bg: (_c, s) => `\x1b[44m${s}\x1b[49m`, bold: s => `\x1b[1m${s}\x1b[22m` },
    keybindings: { matches: () => false }, requestRender: () => {},
    loadCurrent: async () => [item], loadAll: async () => [item], onSelect: () => {}, onCancel: () => {},
  });
  const check = () => {
    for (const width of [252, 80, 20, 10, 2, 1, 0, 40, 252]) {
      for (const line of c.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
    }
  };
  try {
    check(); // loading
    await new Promise(r => setImmediate(r));
    check();
    // Exercise all render branches without invoking filesystem actions.
    const state = c as any;
    state.scope = "all"; check();
    state.showHelp = true; check(); state.showHelp = false;
    state.statusMessage = { type: "error", message: "⚡".repeat(300) }; check();
    state.queryError = "⚡".repeat(300); check();
    state.confirmingDelete = item; check(); state.confirmingDelete = null;
    state.confirmingReverseSync = { reparents: 1, deletes: 2, archives: 3 }; check();
    state.confirmingPathMerge = ["路径⚡".repeat(100)]; check(); state.confirmingPathMerge = null;
    state.mode = "rename"; state.renameInput.setValue("🦄".repeat(100)); check();
    state.mode = "list"; state.flat = []; check();
  } finally { c.dispose(); }
});
