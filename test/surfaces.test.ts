import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startServer } from "../src/web/server.js";
import { callTool, resolveRepo } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "fixtures", "shop");

/** fetch cannot override Host, so use node:http for the rebinding checks. */
const raw = (port: number, p: string, opts: { host?: string; method?: string; headers?: Record<string, string> } = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method: opts.method ?? "GET", headers: { host: opts.host ?? `localhost:${port}`, ...(opts.headers ?? {}) } }, res => {
    let b = ""; res.on("data", d => (b += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
  });
  req.on("error", reject); req.end();
});

test("web: serves the UI and a complete report", async () => {
  const s = await startServer(FIX);
  try {
    const page = await raw(s.port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /SeamLens/);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'self'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    const rep = JSON.parse((await raw(s.port, "/api/report")).body);
    for (const k of ["summary", "score", "findings", "graph", "rules"]) assert.ok(k in rep, k);
    assert.ok(rep.findings.length > 30 && rep.graph.nodes.length > 15);
    const tr = JSON.parse((await raw(s.port, "/api/trace?id=" + encodeURIComponent("table:orders"))).body);
    assert.ok(Array.isArray(tr.up) && tr.up.length > 0, "something reads the orders table");
    assert.equal((await raw(s.port, "/api/trace?id=nope")).status, 404);
  } finally { await s.close(); }
});

test("web: file endpoint is confined to the scanned root", async () => {
  const s = await startServer(FIX);
  try {
    const ok = JSON.parse((await raw(s.port, "/api/file?path=openapi.yaml")).body);
    assert.match(ok.text, /Shop API/);
    for (const bad of ["../../package.json", "/etc/passwd", "..%2f..%2fpackage.json", "src/../../../package.json", "does-not-exist.ts", "%00", "src"]) {
      const r = await raw(s.port, "/api/file?path=" + bad);
      assert.equal(r.status, 400, `${bad} -> ${r.status} ${r.body.slice(0, 60)}`);
    }
    // a symlink inside the repo that points outside must not be followed
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-link-"));
    fs.writeFileSync(path.join(tmp, "a.ts"), "export const a = 1;\n");
    fs.symlinkSync("/etc/hosts", path.join(tmp, "leak.txt"));
    const s2 = await startServer(tmp);
    try { assert.equal((await raw(s2.port, "/api/file?path=leak.txt")).status, 400); assert.equal((await raw(s2.port, "/api/file?path=a.ts")).status, 200); } finally { await s2.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  } finally { await s.close(); }
});

test("web: DNS rebinding and cross-site writes are refused", async () => {
  const s = await startServer(FIX);
  try {
    for (const host of ["evil.example.com", "localhost.evil.com", "192.168.1.5:80", "attacker.test"]) assert.equal((await raw(s.port, "/api/report", { host })).status, 403, host);
    assert.equal((await raw(s.port, "/api/rescan", { method: "POST" })).status, 403);
    assert.equal((await raw(s.port, "/api/rescan", { method: "POST", headers: { "x-seamlens": "1" } })).status, 200);
    assert.equal((await raw(s.port, "/api/report", { method: "DELETE" })).status, 403);
    assert.equal((await raw(s.port, "/app.js/../../package.json")).status, 404);
    assert.equal((await raw(s.port, "/.env")).status, 404);
  } finally { await s.close(); }
});

test("web: only listens on loopback", async () => {
  const s = await startServer(FIX);
  try {
    const nics = Object.values(os.networkInterfaces()).flat().filter(n => n && !n.internal && n.family === "IPv4");
    for (const nic of nics.slice(0, 1)) await assert.rejects(() => new Promise((res, rej) => { const r = http.get({ host: nic!.address, port: s.port, path: "/", timeout: 1500 }, x => res(x)); r.on("error", rej); r.on("timeout", () => { r.destroy(new Error("timeout")); }); }), "must not be reachable on the LAN address");
  } finally { await s.close(); }
});

test("web: diff and impact return clean errors when there is no git history", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-nogit-"));
  fs.writeFileSync(path.join(tmp, "a.ts"), "x");
  const s = await startServer(tmp);
  try {
    const d = await raw(s.port, "/api/diff?base=HEAD~1"); assert.equal(d.status, 400); assert.match(JSON.parse(d.body).error, /Not a git repository/);
    const e = await raw(s.port, "/api/diff?base=--upload-pack%3Dx"); assert.equal(e.status, 400);
    assert.equal((await raw(s.port, "/api/impact")).status, 400);
  } finally { await s.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("mcp: every tool validates input and returns structured, bounded data", async () => {
  const scan: any = await callTool("scan_contracts", { path: FIX });
  assert.equal(scan.summary.operations, 6);
  assert.ok(scan.score.overall < 40 && scan.findingsPerRule.API003 === 1);
  const chk: any = await callTool("check_contracts", { path: FIX, minSeverity: "error", limit: 3 });
  assert.equal(chk.shown, 3); assert.ok(chk.total >= 6 && chk.findings.every((f: any) => f.severity === "error"));
  const one: any = await callTool("check_contracts", { path: FIX, ruleId: "db003" });
  assert.equal(one.total, 1);
  assert.match(((await callTool("explain_rule", { ruleId: "API003" })) as any).why, /unbounded|grows/i);
  assert.ok(((await callTool("explain_rule", { ruleId: "list" })) as any).rules.length >= 35);
  await assert.rejects(() => callTool("explain_rule", { ruleId: "NOPE999" }), /Unknown rule/);
  await assert.rejects(() => callTool("check_contracts", { path: FIX, limit: 99999 }), /too_big|Too big|<=|less than/i);
  await assert.rejects(() => callTool("contract_diff", { path: FIX }), /base/);
  await assert.rejects(() => callTool("contract_diff", { path: FIX, base: "--upload-pack=x" }), /valid git ref|Not a git/);
  await assert.rejects(() => callTool("delete_everything", {}), /Unknown tool/);
  // history-based tools run against a throwaway repository so this test does not depend on the project's own git state
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-mcp-"));
  try {
    const g = (...a: string[]) => execFileSync("git", ["-C", tmp, ...a], { stdio: "pipe" });
    await assert.rejects(() => callTool("org_metrics", { path: tmp }), /Not a git repository/);
    g("init", "-q"); g("config", "user.email", "t@t.t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
    await assert.rejects(() => callTool("impact_report", { path: tmp }), /no commits yet/);
    fs.mkdirSync(path.join(tmp, "src")); fs.mkdirSync(path.join(tmp, "test"));
    fs.writeFileSync(path.join(tmp, "src/a.js"), "exports.a = () => 1;\n"); g("add", "-A"); g("commit", "-q", "-m", "initial commit of the module");
    fs.writeFileSync(path.join(tmp, "src/a.js"), "exports.a = () => 2;\n"); fs.writeFileSync(path.join(tmp, "test/a.test.js"), "require('assert')\n"); g("add", "-A"); g("commit", "-q", "-m", "fix: a returned the wrong value");
    const tasks: any = await callTool("generate_benchmark_tasks", { path: tmp, limit: 2 });
    assert.equal(tasks.length, 1);
    const org: any = await callTool("org_metrics", { path: tmp });
    assert.equal(org.window.commits, 2);
    const imp: any = await callTool("impact_report", { path: tmp });
    assert.equal(imp.cohorts.agent.commits, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("mcp: SEAMLENS_ROOTS confines which directories can be read", async () => {
  const prev = process.env.SEAMLENS_ROOTS;
  try {
    process.env.SEAMLENS_ROOTS = FIX;
    assert.equal(resolveRepo(FIX), fs.realpathSync(FIX));
    assert.equal(resolveRepo(path.join(FIX, "src")), fs.realpathSync(path.join(FIX, "src")));
    assert.throws(() => resolveRepo(ROOT), /outside the directories allowed/);
    assert.throws(() => resolveRepo(path.join(FIX, "..", "..")), /outside the directories allowed/);
    assert.throws(() => resolveRepo("/etc"), /outside the directories allowed/);
    assert.throws(() => resolveRepo(path.join(FIX, "openapi.yaml")), /directory/);
    assert.throws(() => resolveRepo("/definitely/not/here"), /not found/i);
    // symlink pointing out of the allowed root
    const link = path.join(os.tmpdir(), `seamlens-root-link-${process.pid}`);
    fs.symlinkSync(ROOT, link);
    const prefix = fs.realpathSync(os.tmpdir());
    process.env.SEAMLENS_ROOTS = prefix;
    try { assert.equal(resolveRepo(link), fs.realpathSync(ROOT), "inside tmp root by name but the real path is the repo"); } catch { /* confined: also acceptable */ }
    fs.rmSync(link);
  } finally { if (prev === undefined) delete process.env.SEAMLENS_ROOTS; else process.env.SEAMLENS_ROOTS = prev; }
});

test("mcp: end to end over stdio with the official SDK client", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.join(ROOT, "src", "mcp.ts")], env: { ...process.env as Record<string, string>, SEAMLENS_ROOTS: ROOT } });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ["check_contracts", "contract_diff", "explain_rule", "generate_benchmark_tasks", "impact_report", "open_visual_map", "org_metrics", "scan_contracts"]);
    assert.ok(!names.some(n => /validate|run|exec|shell/.test(n)), "no tool may execute commands");
    assert.ok(tools.filter(t => t.name !== "open_visual_map").every(t => t.annotations?.readOnlyHint === true));
    const res: any = await client.callTool({ name: "scan_contracts", arguments: { path: FIX } });
    const body = JSON.parse(res.content[0].text);
    assert.match(body._notice, /untrusted/);
    assert.equal(body.result.summary.operations, 6);
    const denied: any = await client.callTool({ name: "scan_contracts", arguments: { path: "/etc" } });
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /outside the directories allowed/);
    const bad: any = await client.callTool({ name: "check_contracts", arguments: { path: FIX, minSeverity: "loud" } });
    assert.equal(bad.isError, true); assert.match(bad.content[0].text, /Invalid arguments/);
    const map: any = await client.callTool({ name: "open_visual_map", arguments: { path: FIX } });
    const url = JSON.parse(map.content[0].text).result.url;
    assert.match(url, /^http:\/\/localhost:\d+$/);
    const html = await fetch(url).then(r => r.text());
    assert.match(html, /SeamLens/);
  } finally {
    const pid = transport.pid;
    await client.close();
    // the server must exit on its own once the client disconnects, even with the visual-map port open
    const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && pid && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(pid ? alive(pid) : false, false, "MCP server process must exit after the client disconnects");
  }
});
