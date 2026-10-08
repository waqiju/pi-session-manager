import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import MarkdownIt from "markdown-it";

export function useWebPreview(env: NodeJS.ProcessEnv): boolean {
  const mode = (env.PI_GARDEN_OPEN_MODE ?? "auto").trim();
  if (!["auto", "web", "local"].includes(mode)) throw new Error("PI_GARDEN_OPEN_MODE 必须为 auto / web / local");
  return mode === "web" || (mode === "auto" && Boolean(env.SSH_CONNECTION || env.SSH_CLIENT));
}

export function previewPort(env: NodeJS.ProcessEnv): number {
  const raw = (env.PI_GARDEN_PREVIEW_PORT ?? "13322").trim();
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error("PI_GARDEN_PREVIEW_PORT 必须为 1–65535 的整数");
  }
  return Number(raw);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
};
const css = `:root{color-scheme:light dark}body{max-width:1100px;margin:32px auto;padding:0 24px;font:16px/1.7 system-ui,sans-serif;overflow-wrap:anywhere}pre{padding:16px;background:light-dark(#f3f4f6,#20242b);overflow:auto;white-space:pre}code{font-family:ui-monospace,monospace}table{display:block;overflow:auto;border-collapse:collapse}td,th{border:1px solid #8886;padding:6px 12px}blockquote{margin-left:0;padding-left:16px;border-left:4px solid #8886}a{color:light-dark(#1769aa,#8ab4f8)}`;

/** Read-only, process-owned server. No sockets are opened until urlFor() is called. */
export class GardenPreview {
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private roots: string[] = [];
  private markdown = new MarkdownIt({ html: false, linkify: false });
  readonly port: number;

  constructor(port = 13322) {
    this.port = port;
    // Session text may include remote tracking images. Never load embedded resources.
    this.markdown.renderer.rules.image = (tokens, i) => escape(tokens[i].content);
    const linkOpen = this.markdown.renderer.rules.link_open;
    this.markdown.renderer.rules.link_open = (tokens, i, options, env, self) => {
      tokens[i].attrSet("rel", "noreferrer noopener");
      return linkOpen ? linkOpen(tokens, i, options, env, self) : self.renderToken(tokens, i, options);
    };
  }

  private async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.starting) return this.starting;
    const server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      res.setHeader("X-Garden-Preview", "1");
      const fail = (code: number, detail = "Not Found") => {
        res.statusCode = code;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(req.method === "HEAD" ? undefined : `Garden preview: ${detail}`);
      };
      void (async () => {
        if (req.method !== "GET" && req.method !== "HEAD") return fail(405);
        let segments: string[];
        try {
          segments = (req.url ?? "").split("?")[0].split("/").slice(1).map(decodeURIComponent);
        } catch { return fail(400); }
        const [rootId, ...parts] = segments;
        if (!/^r\d+$/.test(rootId ?? "")) return fail(404);
        const root = this.roots[Number(rootId.slice(1))];
        if (!root || !parts.length || parts.some((p) => !p || p === "." || p === ".." || /[\\/\0]/.test(p))) return fail(404);
        const file = await realpath(path.join(root, ...parts));
        if (!inside(root, file) || !file.endsWith(".md")) return fail(404);
        const info = await stat(file);
        if (!info.isFile()) return fail(404);
        if (info.size > 32 * 1024 * 1024) return fail(413);
        const source = await readFile(file, "utf8");
        const body = this.markdown.render(source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""));
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(req.method === "HEAD" ? undefined : `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(path.basename(file))}</title><style>${css}</style></head><body>${body}</body></html>`);
      })().catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") return fail(404, "Markdown file not found");
        if (e.code === "EACCES" || e.code === "EPERM") return fail(403, "Markdown file is not readable");
        fail(500, "Unable to render Markdown");
      });
    });
    this.server = server;
    this.starting = new Promise<void>((resolve, reject) => {
      const error = (e: NodeJS.ErrnoException) => {
        this.server = undefined;
        reject(new Error(e.code === "EADDRINUSE" ? `预览端口 ${this.port} 已占用；请设置 PI_GARDEN_PREVIEW_PORT 并同步调整 SSH -L` : e.message));
      };
      server.once("error", error);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", error);
        // Requests handle their own errors; a runtime socket error must not crash pi.
        server.on("error", () => {});
        server.unref();
        resolve();
      });
    });
    try { await this.starting; } finally { this.starting = undefined; }
  }

  async urlFor(gardenRoot: string, file: string): Promise<string> {
    const root = await realpath(gardenRoot);
    const target = await realpath(file);
    if (!inside(root, target) || !target.endsWith(".md")) throw new Error("预览文件必须是 garden 根目录内的 Markdown");
    let id = this.roots.indexOf(root);
    if (id < 0) { id = this.roots.length; this.roots.push(root); }
    await this.start();
    const relative = path.relative(root, target).split(path.sep).map(encodeURIComponent).join("/");
    return `http://localhost:${this.port}/r${id}/${relative}`;
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
