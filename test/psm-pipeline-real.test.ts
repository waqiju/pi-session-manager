import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPipeline } from "../src/psm/cli.ts";
import { requestStop, restartRun } from "../src/psm/lifecycle.ts";
import { delay, readJson, writeJson } from "../src/psm/files.ts";
import { inspectRun, listRuns } from "../src/psm/runs.ts";

const tool = (name: string) => `export default pi => pi.registerTool({name:${JSON.stringify(name)},label:'test',description:'test tool',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}],details:{}})});`;
async function wait(check: () => boolean) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { if (check()) return; await delay(50); }
  throw new Error("Real pipeline test timed out");
}

test("real Pi pipelines inherit resources and MCP, isolate resources, and execute search/fetch", { skip: !process.env.PSM_REAL_PI, timeout: 90000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "psm-real-pipeline-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "psm");
  const source = path.join(root, "pi");
  mkdirSync(cwd); mkdirSync(source);
  const previous = process.env.PSM_HOME;
  process.env.PSM_HOME = home;
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body); requests.push(payload);
      const isSearch = JSON.stringify(payload.messages).includes("search-now");
      const toolMessages = payload.messages.filter((m: any) => m.role === "tool");
      const name = toolMessages.length === 0 ? "web_search" : "web_fetch";
      const call = isSearch && toolMessages.length < 2;
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${toolMessages.length}`, type: "function", function: { name,
        arguments: JSON.stringify(name === "web_search" ? { query: "test news" } : { url: "https://example.com/source" }) } }] }
        : { role: "assistant", content: isSearch ? "Verified source: https://example.com/source" : "inherit ready" };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: any, finish_reason: string | null) => ({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta, finish_reason }] });
      response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, call ? "tool_calls" : "stop"))}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  writeJson(path.join(home, "config.json"), { defaultModel: "psm-local/test", piCommand: [process.env.PSM_REAL_PI], pollMs: 50, stableMs: 100, startupTimeoutMs: 20000, turnTimeoutMs: 20000 });
  writeJson(path.join(home, "models.json"), { providers: { "psm-local": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-only",
    models: [{ id: "test", contextWindow: 32768, maxTokens: 1024 }] } } });
  writeJson(path.join(home, "auth.json"), { deepseek: { type: "api_key", key: "local-only" } });
  const stop = async (dir: string) => { await requestStop(dir); await wait(() => inspectRun(dir).state === "stopped"); };
  try {
    mkdirSync(path.join(source, "extensions"));
    writeFileSync(path.join(source, "extensions/inherited.ts"), tool("inherited_tool"));
    mkdirSync(path.join(source, "skills/probe"), { recursive: true });
    writeFileSync(path.join(source, "skills/probe/SKILL.md"), "---\nname: inherited-skill\ndescription: inherited-skill-marker\n---\nTest instructions\n");
    writeFileSync(path.join(source, "AGENTS.md"), "inherited-global-instructions-marker");
    writeFileSync(path.join(cwd, "AGENTS.md"), "project-instructions-marker");
    mkdirSync(path.join(cwd, ".pi/extensions"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi/extensions/project.ts"), tool("project_tool"));
    mkdirSync(path.join(source, "local-package/extensions"), { recursive: true });
    writeFileSync(path.join(source, "local-package/extensions/pkg.ts"), tool("package_tool"));
    writeJson(path.join(source, "settings.json"), { packages: ["./local-package"], defaultTools: ["read"] });
    const mcp = path.join(source, "mcp-server.mjs");
    writeFileSync(mcp, `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;
let result={};if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}};
if(q.method==='tools/list')result={tools:[{name:'probe',description:'Inherited MCP probe',inputSchema:{type:'object',properties:{}}}]};
if(q.method==='tools/call')result={content:[{type:'text',text:'ok'}]};
console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`);
    writeJson(path.join(source, "mcp.json"), { mcpServers: { probe: { command: process.execPath, args: [mcp], exposure: "direct" } } });
    mkdirSync(path.join(home, "inherit"));
    writeFileSync(path.join(home, "inherit/pipeline.mjs"), `export default ()=>({agentDir:${JSON.stringify(source)}});`);
    const inherited = await startPipeline(cwd, "inherit", "Reply briefly.");
    await wait(() => readJson(path.join(inherited.dir, "001.status.json"), {}).state === "completed");
    const first = requests[0];
    const names = first.tools.map((t: any) => t.function.name);
    for (const name of ["inherited_tool", "project_tool", "package_tool", "mcp__probe__probe"]) assert.ok(names.includes(name), `${name} missing: ${names}`);
    assert.match(JSON.stringify(first.messages), /inherited-global-instructions-marker/);
    assert.match(JSON.stringify(first.messages), /project-instructions-marker/);
    assert.match(JSON.stringify(first.messages), /inherited-skill-marker/);
    await stop(inherited.dir);
    assert.equal((await restartRun(inherited.dir)).restartCount, 1);
    await stop(inherited.dir);

    const example = fileURLToPath(new URL("../examples/pipelines/web-search", import.meta.url));
    const searchDir = path.join(home, "web-search");
    cpSync(example, searchDir, { recursive: true });
    // Intercept only the official search endpoint inside the real Pi process; no external requests.
    writeFileSync(path.join(searchDir, "mock.ts"), `export default () => { const original=globalThis.fetch; globalThis.fetch=async (url,options)=> {
if(String(url).startsWith('https://api.deepseek.com/v1/tools/'))return Response.json(String(url).endsWith('/search')?{results:[{title:'Source',url:'https://example.com/source',summary:'Verified news',date:'2026-11-09'}]}:{title:'Source',content:'Verified article body'});
return original(url,options);};};`);
    writeFileSync(path.join(searchDir, "pipeline.mjs"), `export default ({pipelineDir})=>({resources:'isolated',extensions:[pipelineDir+'/tools/deepseek-search.ts',pipelineDir+'/mock.ts'],tools:['read','web_search','web_fetch'],appendSystemPrompt:'Search and cite actual sources.'});`);
    const offset = requests.length;
    const search = await startPipeline(cwd, "web-search", "search-now");
    await wait(() => ["completed", "failed"].includes(readJson(path.join(search.dir, "001.status.json"), {}).state));
    assert.equal(readJson(path.join(search.dir, "001.status.json")).state, "completed");
    const searchRequests = requests.slice(offset);
    assert.equal(searchRequests.length, 3);
    assert.deepEqual(searchRequests[0].tools.map((t: any) => t.function.name).sort(), ["read", "web_fetch", "web_search"]);
    assert.doesNotMatch(JSON.stringify(searchRequests[0].messages), /inherited-global-instructions-marker|project-instructions-marker|inherited-skill-marker/);
    assert.match(JSON.stringify(searchRequests[1].messages), /Verified news/);
    assert.match(JSON.stringify(searchRequests[2].messages), /Verified article body/);
    assert.match(readFileSync(path.join(search.dir, "001.out.md"), "utf8"), /https:\/\/example.com\/source/);
    const events = readFileSync(path.join(search.dir, "logs/events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "tool_execution_end" && !event.isError).length, 2);
    await stop(search.dir);

    const uiDir = path.join(home, "interactive");
    mkdirSync(uiDir);
    writeFileSync(path.join(uiDir, "ask.ts"), `export default pi => pi.on('before_agent_start', async (_event,ctx) => { await ctx.ui.confirm('Needs input','Continue?'); });`);
    writeFileSync(path.join(uiDir, "pipeline.mjs"), `export default ({pipelineDir})=>({resources:'isolated',extensions:[pipelineDir+'/ask.ts'],config:{stableMs:500}});`);
    const interactive = await startPipeline(cwd, "interactive", "Request interactive UI");
    await wait(() => inspectRun(interactive.dir).state === "failed");
    assert.match(inspectRun(interactive.dir).error!, /no interactive UI/);
    assert.notEqual(readJson(path.join(interactive.dir, "001.status.json"), {}).state, "completed");
  } finally {
    for (const run of listRuns(home, true)) if (run.alive) { await requestStop(run.dir); await wait(() => !inspectRun(run.dir).alive); }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PSM_HOME; else process.env.PSM_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
