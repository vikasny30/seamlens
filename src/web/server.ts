import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { analyze, type Report } from "../index.js";
import { safeResolve } from "../scan/walk.js";
import { diffRepo } from "../diff/index.js";
import { analyzeImpact } from "../impact/index.js";
import { analyzeOrg } from "../org/index.js";
import { trace } from "../graph.js";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_FILE = 1_000_000;

export interface ServerHandle { url: string; port: number; close: () => Promise<void> }

export async function startServer(rootIn: string, opts: { port?: number; host?: string } = {}): Promise<ServerHandle> {
  const root = fs.realpathSync(rootIn);
  let cached: { report: Report; at: number } | null = null;
  const load = (refresh = false) => { if (!cached || refresh) cached = { report: analyze(root).report, at: Date.now() }; return cached; };

  const send = (res: http.ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8") => {
    res.writeHead(code, {
      "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding defence: only loopback host names are served.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!HOSTS.has(host)) return send(res, 403, { error: "forbidden host" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const isRead = req.method === "GET" || req.method === "HEAD";
      // Cross-site defence for anything that changes state: a custom header forces a CORS preflight that this server never grants.
      if (!isRead && req.headers["x-seamlens"] !== "1") return send(res, 403, { error: "missing x-seamlens header" });

      if (isRead && !url.pathname.startsWith("/api/")) {
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!/^[\w.-]+$/.test(name) || !(path.extname(name) in TYPES)) return send(res, 404, "not found", "text/plain");
        try { return send(res, 200, fs.readFileSync(path.join(UI_DIR, name)), TYPES[path.extname(name)]); } catch { return send(res, 404, "not found", "text/plain"); }
      }

      if (url.pathname === "/api/report" && isRead) {
        const c = load(url.searchParams.get("refresh") === "1");
        return send(res, 200, { ...c.report, scannedAt: c.at });
      }
      if (url.pathname === "/api/rescan" && req.method === "POST") { const c = load(true); return send(res, 200, { ok: true, scannedAt: c.at }); }

      if (url.pathname === "/api/file" && isRead) {
        const rel = url.searchParams.get("path") ?? "";
        const real = rel && !rel.includes("\0") ? safeResolve(root, rel) : null;
        if (!real) return send(res, 400, { error: "path is outside the scanned repository or does not exist" });
        const st = fs.statSync(real);
        if (!st.isFile() || st.size > MAX_FILE) return send(res, 400, { error: "not a readable text file (missing or over 1 MB)" });
        const buf = fs.readFileSync(real);
        if (buf.includes(0)) return send(res, 400, { error: "binary file" });
        return send(res, 200, { path: rel, text: buf.toString("utf8") });
      }

      if (url.pathname === "/api/trace" && isRead) {
        const id = url.searchParams.get("id") ?? "";
        const g = load().report.graph;
        if (!g.nodes.some(n => n.id === id)) return send(res, 404, { error: "unknown node" });
        const t = trace(g, id);
        return send(res, 200, { down: [...t.down], up: [...t.up] });
      }

      if (url.pathname === "/api/diff" && isRead) {
        try { return send(res, 200, diffRepo(root, url.searchParams.get("base") ?? "HEAD~1")); } catch (e) { return send(res, 400, { error: (e as Error).message }); }
      }
      if (url.pathname === "/api/impact" && isRead) {
        try { const d = Number(url.searchParams.get("since")) || undefined; return send(res, 200, analyzeImpact(root, { sinceDays: d })); } catch (e) { return send(res, 400, { error: (e as Error).message }); }
      }
      if (url.pathname === "/api/org" && isRead) {
        try { const gh = url.searchParams.get("github") || undefined; return send(res, 200, await analyzeOrg(root, { github: gh })); } catch (e) { return send(res, 400, { error: (e as Error).message }); }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) { return send(res, 500, { error: "internal error" }); }
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise(r => server.close(() => r())) };
}
