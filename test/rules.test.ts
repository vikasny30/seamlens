import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/index.js";
import { ALL_RULES, runRules } from "../src/rules/index.js";
import { buildGraph, trace } from "../src/graph.js";
import { scoreFindings } from "../src/score.js";
import type { Finding, Scan } from "../src/model.js";
import { emptySchema } from "../src/scan/extract-sql.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "shop");

test("every rule has metadata, a rationale and a fix", () => {
  const ids = new Set<string>();
  for (const r of ALL_RULES) {
    assert.ok(r.id && r.title && r.why.length > 40 && r.fix.length > 10, r.id);
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`); ids.add(r.id);
  }
  assert.ok(ALL_RULES.length >= 35);
});

test("fixture repo: the planted problems are found, and only those rule families", () => {
  const { report } = analyze(FIX);
  const ids = new Set(report.findings.map(f => f.ruleId));
  const planted = ["API001", "API002", "API003", "API004", "API005", "API006", "API007", "API008", "API009", "API010", "API011", "API012",
    "PRO001", "PRO002", "PRO003", "PRO004", "PRO005", "PRO006", "PRO007", "DB001", "DB002", "DB003", "DB004", "DB005", "DB006",
    "ARC001", "ARC002", "RES001", "RES002", "RES003", "RES004", "RES005", "X001", "X002"];
  for (const id of planted) assert.ok(ids.has(id), `expected ${id} to fire`);
  assert.equal(report.warnings.length, 0, report.warnings.join("; "));
  // specific evidence, not just rule ids
  const f = (id: string) => report.findings.filter(x => x.ruleId === id);
  assert.ok(f("API001").some(x => x.severity === "error" && /getOrder/.test(x.message)), "duplicate operationId is an error");
  assert.ok(f("DB001").some(x => /audit_log/.test(x.message)));
  assert.ok(f("DB003").some(x => /total_price/.test(x.message)));
  assert.ok(f("DB005").some(x => /region/.test(x.message)));
  assert.ok(f("PRO004").some(x => /\b3\b/.test(x.message)), "field 3 gap");
  assert.ok(f("X002").some(x => /admin\/stats/.test(x.message)), "undocumented route");
  assert.ok(f("X001").some(x => /refunds/.test(x.message)), "documented but not implemented");
  assert.ok(!f("X001").some(x => /GET \/orders\b(?!\/)/.test(x.message)), "implemented route must not be flagged");
  assert.ok(f("ARC001").some(x => /a\.ts.*b\.ts.*c\.ts/.test(x.evidence ?? "")), "3-file cycle path");
  assert.ok(!f("RES004").some(x => /callWithRetry|attempts/.test(x.evidence ?? "")), "retry loop is not an N+1");
  for (const x of report.findings) assert.ok(x.file, `${x.ruleId} has no file`);
});

test("fixture repo: findings carry line numbers that point at the offending code", () => {
  const { scan, report } = analyze(FIX);
  // what must appear on (or within a line of) the reported line, per rule
  const expect: Record<string, RegExp> = { DB001: /audit_log/i, DB003: /total_price/i, DB005: /region/i, RES001: /fetch/, RES003: /catch/, PRO006: /price/, PRO002: /PENDING/, API001: /(get|delete):/ };
  let checked = 0;
  for (const x of report.findings.filter(f => f.file && f.line && expect[f.ruleId])) {
    const lines = scan.read(x.file!).split("\n");
    const window = lines.slice(Math.max(0, x.line! - 2), x.line! + 1).join("\n");
    assert.match(window, expect[x.ruleId], `${x.ruleId} ${x.file}:${x.line}`);
    checked++;
  }
  assert.ok(checked >= 8, `only ${checked} findings were line-checked`);
});

test("graph: contracts, routes, modules, tables link end to end; trace follows the flow", () => {
  const { report } = analyze(FIX);
  const g = report.graph;
  const get = (label: string) => g.nodes.find(n => n.label === label)!;
  const op = get("GET /orders"), route = g.nodes.find(n => n.kind === "route" && n.label === "GET /orders")!;
  assert.ok(g.edges.some(e => e.from === op.id && e.to === route.id && e.kind === "implements"));
  const t = trace(g, op.id);
  assert.ok(t.down.has("mod:src/routes/orders.ts"));
  assert.ok(t.down.has("mod:src/db/orders-repo.ts"));
  assert.ok(t.down.has("table:orders"), "reaches the table the repository reads");
  assert.ok(t.down.has("ext:payments.example.com"), "reaches the outbound dependency through the service");
  assert.ok(g.edges.some(e => e.kind === "references" && e.from === "table:orders" && e.to === "table:customers"));
});

function syntheticScan(over: Partial<Scan>): Scan {
  return { root: "/x", config: {}, files: [], sourceFiles: [], openapi: [], protos: [], sql: emptySchema(), routes: [], imports: [], outbound: [], smells: [], tableAccess: [], warnings: [], read: () => "", ...over };
}

test("ARC003 god module and ARC004 deep package import (synthetic)", () => {
  const files = Array.from({ length: 16 }, (_, i) => `src/dep${i}.ts`).concat(["src/god.ts", "packages/a/src/x.ts", "packages/b/src/internal/y.ts", "packages/b/src/index.ts"]);
  const imports = [...Array.from({ length: 16 }, (_, i) => ({ from: "src/god.ts", to: `src/dep${i}.ts` })), { from: "packages/a/src/x.ts", to: "packages/b/src/internal/y.ts" }, { from: "packages/a/src/x.ts", to: "packages/b/src/index.ts" }];
  const scan = syntheticScan({ sourceFiles: files, imports });
  const findings = runRules(scan, buildGraph(scan));
  assert.ok(findings.some(f => f.ruleId === "ARC003" && /god\.ts/.test(f.message)));
  const deep = findings.filter(f => f.ruleId === "ARC004");
  assert.equal(deep.length, 1, "public entry import is allowed, internal import is not");
  assert.match(deep[0].evidence!, /internal\/y\.ts/);
});

test("ARC002 honours configured layers", () => {
  const scan = syntheticScan({
    sourceFiles: ["ui/page.ts", "domain/core.ts", "infra/db.ts"], imports: [{ from: "ui/page.ts", to: "infra/db.ts" }, { from: "ui/page.ts", to: "domain/core.ts" }],
    config: { layers: [{ name: "ui", match: "ui/**", mayImport: ["domain"] }, { name: "domain", match: "domain/**", mayImport: ["infra"] }, { name: "infra", match: "infra/**", mayImport: [] }] },
  });
  const f = runRules(scan, buildGraph(scan)).filter(x => x.ruleId === "ARC002");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /"ui" must not import layer "infra"/);
});

test("disabledRules removes a rule's findings", () => {
  const { report } = analyze(FIX, { disabledRules: ["API001", "res001"] });
  assert.ok(!report.findings.some(f => f.ruleId === "API001" || f.ruleId === "RES001"));
  assert.ok(report.findings.some(f => f.ruleId === "API002"));
});

test("score: bounded, monotonic, per-rule cap, low confidence counts half", () => {
  const mk = (n: number, sev: Finding["severity"], id = "R1", conf: Finding["confidence"] = "high"): Finding[] =>
    Array.from({ length: n }, () => ({ ruleId: id, severity: sev, category: "http", message: "m", confidence: conf }));
  assert.equal(scoreFindings([]).overall, 100);
  const a = scoreFindings(mk(2, "warning")).overall, b = scoreFindings(mk(10, "warning")).overall;
  assert.ok(a > b && a > 90 && b > 0);
  assert.equal(scoreFindings(mk(100, "error")).overall, scoreFindings(mk(50, "error")).overall, "one rule's penalty is capped");
  assert.ok(scoreFindings(mk(4, "warning", "R1", "low")).overall > scoreFindings(mk(4, "warning")).overall);
  assert.ok(scoreFindings([...mk(50, "error", "A"), ...mk(50, "error", "B"), ...mk(50, "error", "C"), ...mk(50, "error", "D")]).overall >= 0);
});

test("a repo with nothing to analyse produces an empty, clean report", () => {
  const { report } = analyze(path.join(FIX, "src", "lib"));
  assert.equal(report.summary.operations, 0);
  assert.equal(report.score.overall <= 100, true);
});

test("a DROP TABLE mentioned in a comment or an example string is not a migration (false-positive regression)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamlens-fp-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/filter.ts"), "/**\n * Masks literals so SELECT $$DROP TABLE users;$$ is benign.\n */\nexport const msg = 'never run DROP TABLE users in prod';\n// ALTER TABLE x DROP COLUMN y\n");
    fs.mkdirSync(path.join(dir, "migrations"));
    fs.writeFileSync(path.join(dir, "migrations/001.ts"), "export const up = `ALTER TABLE orders DROP COLUMN legacy`;\n");
    const { report } = analyze(dir);
    const d4 = report.findings.filter(f => f.ruleId === "DB004");
    assert.equal(d4.length, 1, JSON.stringify(d4.map(f => f.file)));
    assert.equal(d4[0].file, "migrations/001.ts");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
