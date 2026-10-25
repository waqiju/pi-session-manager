import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import shortcut from "../examples/personal-shortcuts/garden-shortcut.ts";

function setup(enabled = true) {
  const shortcuts = new Map<string, any>();
  const sent: unknown[][] = [];
  shortcut({
    registerShortcut: (key: string, options: unknown) => shortcuts.set(key, options),
    getCommands: () => enabled ? [{ name: "garden" }] : [],
    sendUserMessage: (...args: unknown[]) => sent.push(args),
  } as any);
  return { shortcuts, sent };
}

test("personal shortcut dispatches /garden explicitly without touching editor text", () => {
  const { shortcuts, sent } = setup();
  assert.deepEqual([...shortcuts.keys()], ["ctrl+g"]);
  shortcuts.get("ctrl+g").handler({});
  assert.deepEqual(sent, [["/garden", { expandPromptTemplates: true }]]);
});

test("disabled garden does not send a literal command to the model", () => {
  const { shortcuts, sent } = setup(false);
  shortcuts.get("ctrl+g").handler({});
  assert.deepEqual(sent, []);
});

test("personal keybindings release Ctrl+G and Ctrl+E while preserving End", () => {
  const bindings = JSON.parse(readFileSync(new URL("../examples/personal-shortcuts/keybindings.json", import.meta.url), "utf8"));
  assert.equal(bindings["app.editor.external"], "ctrl+e");
  assert.deepEqual(bindings["tui.editor.cursorLineEnd"], ["end"]);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./extensions/garden.ts"]);
});
