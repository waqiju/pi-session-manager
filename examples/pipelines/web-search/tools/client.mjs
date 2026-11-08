import { setTimeout as delay } from "node:timers/promises";

const endpoint = "https://api.deepseek.com/v1/tools/";
const maxResponseBytes = 8 * 1024 * 1024;

export function validateRequest(kind, input) {
  if (kind === "search") {
    if (typeof input.query !== "string" || !input.query.trim() || [...input.query].length > 128)
      throw new Error("Search query must contain 1–128 Unicode characters");
    if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 50))
      throw new Error("Search count must be an integer from 1 to 50");
    if (input.need_content !== undefined && typeof input.need_content !== "boolean") throw new Error("need_content must be boolean");
    return { query: input.query, count: input.count ?? 5, need_content: input.need_content ?? false };
  }
  if (kind !== "fetch") throw new Error("Unknown DeepSeek tool");
  let url;
  try { url = new URL(input.url); } catch { throw new Error("Fetch requires an HTTP(S) URL"); }
  if (typeof input.url !== "string" || input.url.length > 8192 || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Fetch requires an HTTP(S) URL without credentials, at most 8192 characters");
  return { url: input.url };
}

async function boundedJson(response) {
  if (!response.body) throw new Error("DeepSeek returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error("DeepSeek response exceeds 8 MiB");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("DeepSeek returned invalid JSON"); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Dependencies are injectable for offline tests; production always uses the official HTTPS endpoint. */
export async function requestDeepSeek(kind, input, apiKey, signal, options = {}) {
  const body = validateRequest(kind, input);
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("DeepSeek API key missing; configure PSM DeepSeek auth or DEEPSEEK_API_KEY");
  const fetcher = options.fetch ?? globalThis.fetch;
  const wait = options.delay ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 30000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let attempt = 0; attempt < 3; attempt++) {
    combined.throwIfAborted();
    let response;
    try {
      response = await fetcher(endpoint + kind, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: combined, redirect: "error",
      });
    } catch {
      if (signal?.aborted) throw new Error("DeepSeek request cancelled");
      if (deadline.aborted) throw new Error("DeepSeek request timed out after 30 seconds");
      if (attempt < 2) { await wait(500 * 2 ** attempt, combined); continue; }
      throw new Error("DeepSeek network request failed (check DNS, connectivity and proxy settings)");
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (retryable && attempt < 2) { await wait(500 * 2 ** attempt, combined); continue; }
      const reason = { 400: "invalid request", 401: "authentication failed", 402: "insufficient balance", 403: "fetch rejected by policy", 404: "page content unavailable", 429: "rate limited" }[response.status] ?? "service error";
      // Do not echo upstream bodies or headers: they can contain credentials or proxy diagnostics.
      throw new Error(`DeepSeek ${kind}: HTTP ${response.status} (${reason})`);
    }
    const data = await boundedJson(response);
    if (kind === "search") {
      if (!Array.isArray(data.results) || data.results.some((r) => !r || typeof r.title !== "string" || typeof r.url !== "string"))
        throw new Error("Invalid DeepSeek search response");
      return { results: data.results.map((r) => ({ title: r.title, url: r.url,
        summary: typeof r.summary === "string" ? r.summary : "", snippet: typeof r.snippet === "string" ? r.snippet : "",
        date: typeof r.date === "string" ? r.date : null, content: typeof r.content === "string" ? r.content : "" })) };
    }
    if (typeof data.title !== "string" || typeof data.content !== "string") throw new Error("Invalid DeepSeek fetch response");
    return { url: body.url, title: data.title, content: data.content };
  }
}
