import test from "node:test";
import assert from "node:assert/strict";
import { requestDeepSeek } from "../examples/pipelines/web-search/tools/client.mjs";
import extension from "../examples/pipelines/web-search/tools/deepseek-search.ts";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

const result = { results: [{ title: "A source", url: "https://example.com/news", summary: "Verified", date: "2026-11-09" }] };

test("search and fetch use official endpoints and return source data", async () => {
  const calls: any[] = [];
  const fetcher = async (url: string, options: any) => {
    calls.push({ url, options });
    return Response.json(url.endsWith("/search") ? result : { title: "A page", content: "# Source" });
  };
  const searched = await requestDeepSeek("search", { query: "test" }, "test-key", undefined, { fetch: fetcher });
  assert.equal(searched.results[0].url, "https://example.com/news");
  assert.equal(searched.results[0].date, "2026-11-09");
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), { query: "test", count: 5, need_content: false });
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(await requestDeepSeek("fetch", { url: "https://example.com" }, "test-key", undefined, { fetch: fetcher }),
    { url: "https://example.com", title: "A page", content: "# Source" });
});

test("search validation, empty results, errors, bounded retry and credential-safe diagnostics", async () => {
  const never = async () => { throw Error("must not request"); };
  for (const input of [{ query: " " }, { query: "x".repeat(129) }, { query: "x", count: 51 }, { query: "x", need_content: "yes" }])
    await assert.rejects(requestDeepSeek("search", input, "key", undefined, { fetch: never }));
  for (const url of ["file:///etc/passwd", "https://user:secret@example.com", "not a url"])
    await assert.rejects(requestDeepSeek("fetch", { url }, "key", undefined, { fetch: never }));
  await assert.rejects(requestDeepSeek("search", { query: "x" }, "", undefined, { fetch: never }), /key missing/);
  assert.deepEqual(await requestDeepSeek("search", { query: "x" }, "key", undefined, { fetch: async () => Response.json({ results: [] }) }), { results: [] });
  for (const status of [401, 402, 403, 404]) {
    let calls = 0;
    await assert.rejects(requestDeepSeek("search", { query: "x" }, "secret", undefined, { fetch: async () => { calls++; return new Response("secret", { status }); } }),
      (error: Error) => error.message.includes(`HTTP ${status}`) && !error.message.includes("secret"));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const delays: number[] = [];
  await requestDeepSeek("search", { query: "x" }, "key", undefined, { fetch: async () => ++calls < 3 ? new Response("", { status: 429 }) : Response.json(result), delay: async (ms: number) => { delays.push(ms); } });
  assert.deepEqual(delays, [500, 1000]);
  calls = 0;
  await assert.rejects(requestDeepSeek("search", { query: "x" }, "secret", undefined, { fetch: async () => { calls++; throw Error("secret in proxy URL"); }, delay: async () => {} }),
    (error: Error) => /network/.test(error.message) && !error.message.includes("secret"));
  assert.equal(calls, 3);
  await assert.rejects(requestDeepSeek("search", { query: "x" }, "key", undefined, { fetch: async () => Response.json({ wrong: [] }) }), /Invalid.*response/);
});

test("cancellation, timeout and oversized upstream responses terminate", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestDeepSeek("search", { query: "x" }, "key", controller.signal));
  await assert.rejects(requestDeepSeek("search", { query: "x" }, "key", undefined, {
    timeoutMs: 10,
    fetch: async (_url: string, options: any) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(Error("late")), 1000);
      options.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(Error("abort")); });
    }),
  }), /timed out/);
  await assert.rejects(requestDeepSeek("search", { query: "x" }, "key", undefined, {
    fetch: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)),
  }), /exceeds/);
});

test("extension registers both tools, resolves provider auth, and saves truncated results", async () => {
  const tools: any[] = [];
  extension({ registerTool: (tool: any) => tools.push(tool) } as any);
  assert.deepEqual(tools.map((tool) => tool.name), ["web_search", "web_fetch"]);
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let fullFile: string | undefined;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal((options!.headers as any).Authorization, "Bearer stored-key");
      return Response.json({ title: "Large", content: "中文".repeat(40000) });
    };
    const output = await tools[1].execute("call", { url: "https://example.com" }, undefined, undefined,
      { modelRegistry: { getProviderAuth: async (provider: string) => { assert.equal(provider, "deepseek"); return { auth: { apiKey: "stored-key" } }; } } });
    assert.equal(output.details.truncated, true);
    assert.ok(Buffer.byteLength(output.content[0].text) < 52 * 1024);
    fullFile = output.details.fullOutputPath;
    assert.equal(JSON.parse(readFileSync(fullFile!, "utf8")).content.length, 80000);
    assert.ok(!output.content[0].text.includes("stored-key"));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    if (fullFile) rmSync(path.dirname(fullFile), { recursive: true, force: true });
  }
});
