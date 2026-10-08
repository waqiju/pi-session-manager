import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GardenPreview, previewPort, useWebPreview } from "../src/preview.ts";

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("preview config: SSH detection, explicit override, strict port validation", () => {
  assert.equal(useWebPreview({}), false);
  assert.equal(useWebPreview({ SSH_CONNECTION: "client server" }), true);
  assert.equal(useWebPreview({ SSH_CLIENT: "client" }), true);
  assert.equal(useWebPreview({ SSH_CLIENT: "client", PI_GARDEN_OPEN_MODE: "local" }), false);
  assert.equal(useWebPreview({ PI_GARDEN_OPEN_MODE: "web" }), true);
  assert.throws(() => useWebPreview({ PI_GARDEN_OPEN_MODE: "bad" }));
  assert.equal(previewPort({}), 13322);
  for (const value of ["", "0", "65536", "1.5", "abc"]) assert.throws(() => previewPort({ PI_GARDEN_PREVIEW_PORT: value }));
});

test("preview: render, relative links, fresh reads and path restrictions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "garden-web-"));
  const root = path.join(dir, "garden");
  const project = path.join(root, "--项目--");
  mkdirSync(project, { recursive: true });
  const doc = path.join(project, "中文 + 文档.l3.md");
  writeFileSync(doc, "---\nsecret: frontmatter\n---\n# Hello\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n\n<script>alert(1)</script>\n\n![tracker](https://evil.test/track)\n");
  const index = path.join(project, "index.md");
  writeFileSync(index, `[document](./${encodeURIComponent(path.basename(doc))})`);
  const outside = path.join(dir, "outside.md");
  writeFileSync(outside, "private");
  symlinkSync(outside, path.join(project, "escape.md"));
  symlinkSync(root, path.join(dir, "garden-alias"));
  const preview = new GardenPreview(await freePort());
  try {
    const url = await preview.urlFor(path.join(dir, "garden-alias"), doc);
    const concurrent = await Promise.all([preview.urlFor(root, index), preview.urlFor(root, doc)]);
    assert.equal(concurrent[1], url, "reuse canonical root and port; no token in URL");
    assert.match(new URL(url).pathname, /^\/r0\//);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-garden-preview"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /<h1>Hello<\/h1>/);
    assert.match(html, /<table>/);
    assert.match(html, /language-js/);
    assert.ok(!html.includes("secret: frontmatter"));
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
    const indexHtml = await (await fetch(concurrent[0])).text();
    const href = indexHtml.match(/href="([^"]+)"/)![1];
    assert.equal((await fetch(new URL(href, concurrent[0]))).status, 200);
    writeFileSync(doc, "# Updated");
    assert.match(await (await fetch(url)).text(), /<h1>Updated<\/h1>/);
    const prefix = url.slice(0, url.lastIndexOf("/"));
    for (const suffix of ["escape.md", "%2e%2e%2foutside.md", "%5coutside.md", "file.jsonl", "", "%ZZ"]) {
      assert.ok((await fetch(`${prefix}/${suffix}`)).status >= 400, suffix);
    }
    const missing = await fetch(`${prefix}/missing.md`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Garden preview: Markdown file not found/);
    assert.equal((await fetch(url.replace("/r0/", "/r999/"))).status, 404);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.equal((await fetch(url, { method: "HEAD" })).status, 200);
    await assert.rejects(preview.urlFor(root, outside));
    await preview.close();
    await preview.close();
    await assert.rejects(fetch(url));
  } finally {
    await preview.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview: port conflicts are explicit, never silently use another server", async () => {
  const occupied = createServer();
  await new Promise<void>((r) => occupied.listen(0, "127.0.0.1", r));
  const port = (occupied.address() as { port: number }).port;
  const dir = mkdtempSync(path.join(tmpdir(), "garden-web-conflict-"));
  const doc = path.join(dir, "doc.md");
  writeFileSync(doc, "hello");
  const preview = new GardenPreview(port);
  try {
    await assert.rejects(preview.urlFor(dir, doc), /已占用/);
  } finally {
    await preview.close();
    await new Promise<void>((r) => occupied.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
