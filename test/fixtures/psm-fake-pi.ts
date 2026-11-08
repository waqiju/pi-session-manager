// Deterministic executable RPC fixture; no credentials or network access.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const session = value("--session");
const dir = path.dirname(session);
const expression = value("--model")!;
const [reference, suffix] = expression.split(":");
const slash = reference.indexOf("/");
const model = { provider: value("--provider") || (slash >= 0 ? reference.slice(0, slash) : "fixture"),
  id: slash >= 0 ? reference.slice(slash + 1) : reference === "fuzzy" ? "test" : reference };
const thinkingLevel = value("--thinking") || suffix || "off";
const send = (record: unknown) => process.stdout.write(JSON.stringify(record) + "\r\n");
let seq = 0;
let parentId: string | null = null;
let turn = 0;
writeFileSync(path.join(dir, "observed.json"), JSON.stringify({ cwd: process.cwd(), agent: process.env.PI_CODING_AGENT_DIR,
  sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR, parentSession: process.env.PI_SESSION_ID, args }));
if (existsSync(session)) {
  const entries = readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  seq = entries.filter((e) => e.type === "message").length;
  parentId = entries.at(-1)?.id || null;
  const prompts = path.join(dir, "prompts.jsonl");
  turn = existsSync(prompts) ? readFileSync(prompts, "utf8").trim().split("\n").length : 0;
} else writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
function message(role: string, text: string, stopReason = "stop") {
  const msg = { role, content: [{ type: "text", text }], timestamp: Date.now(), provider: model.provider, model: model.id, stopReason,
    ...(stopReason === "error" ? { errorMessage: "fixture provider failure" } : {}) };
  const id = `entry-${++seq}`;
  appendFileSync(session, JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: msg }) + "\n");
  parentId = id;
  send({ type: "message_end", message: msg });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (command.type === "get_state") {
      if (model.id === "startup-hang") continue;
      send({ type: "response", id: command.id, success: true, data: { model: model.id === "missing" ? undefined : model, thinkingLevel } });
    }
    if (command.type === "prompt") {
      appendFileSync(path.join(dir, "prompts.jsonl"), JSON.stringify(command) + "\n");
      turn++;
      if (command.message === "reject") { send({ type: "response", id: command.id, success: false, error: "fixture rejection" }); continue; }
      if (command.message === "handled") { send({ type: "response", id: command.id, success: true, data: { disposition: "handled" } }); continue; }
      message("user", command.message);
      if (command.message === "crash") process.exit(7);
      if (command.message === "hang") { send({ type: "response", id: command.id, success: true, data: { disposition: "started" } }); continue; }
      message("assistant", "intermediate");
      send({ type: "agent_end", willRetry: true });
      const complete = () => {
        message("assistant", `reply ${turn}: ${command.message}`, command.message === "error" ? "error" : "stop");
        // Split a record across UTF-8 chunks; U+2028/U+2029 must not split JSONL.
        const record = Buffer.from(JSON.stringify({ type: "fixture_unicode", text: "中文\u2028\u2029" }) + "\n");
        const cut = record.indexOf(Buffer.from("中")) + 1;
        process.stdout.write(record.subarray(0, cut));
        process.stdout.write(record.subarray(cut));
        send({ type: "agent_settled", aborted: command.message === "abort" });
      };
      if (command.message === "fast") complete();
      else setTimeout(complete, 200);
      send({ type: "response", id: command.id, success: true, data: { disposition: "started" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
