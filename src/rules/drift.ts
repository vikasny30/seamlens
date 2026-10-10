import type { Finding, RuleMeta } from "../model.js";
import { matchRoute, paramCount } from "../scan/match.js";
import { finding, rule } from "./util.js";

const X001: RuleMeta = { id: "X001", title: "Documented operations are implemented", category: "drift", severity: "warning",
  why: "A contract that promises an endpoint the code does not serve is a lie that consumers build on: they find out in production.",
  fix: "Implement the operation, or remove it from the spec (and publish a deprecation if it ever shipped)." };
const X002: RuleMeta = { id: "X002", title: "Implemented routes are documented", category: "drift", severity: "warning",
  why: "Undocumented routes are invisible to security review, client generation and breaking-change checks, yet consumers will find and depend on them.",
  fix: "Add the route to the OpenAPI spec, or mark it internal and remove it from the public surface." };
const X003: RuleMeta = { id: "X003", title: "Matched routes agree on parameters", category: "drift", severity: "info",
  why: "When a route and its operation disagree on path parameter count, the match is probably a coincidence of prefixes.",
  fix: "Align the route and spec paths; set `basePath` in .seamlens.json if the code mounts the router under a prefix." };

export const driftRules = [
  rule(X001, ({ scan }) => {
    if (!scan.openapi.length) return [];
    const reliable = scan.routes.filter(r => r.confidence !== "low");
    if (!scan.routes.length) return [finding(X001, { severity: "info", message: "No HTTP routes were detected in code, so spec-versus-code drift was not checked (unsupported framework?)", confidence: "low", file: scan.openapi[0].file, line: 1 })];
    const out: Finding[] = [];
    for (const doc of scan.openapi) for (const op of doc.ops) {
      if (scan.routes.some(r => matchRoute(op, r, scan.config.basePath))) continue;
      out.push(finding(X001, { message: `${op.key} is documented but no matching route was found`, file: op.file, line: op.line, nodeId: `op:${doc.file}:${op.key}`, confidence: reliable.length ? "medium" : "low", evidence: op.key }));
    }
    return out;
  }),

  rule(X002, ({ scan }) => {
    if (!scan.routes.length) return [];
    if (!scan.openapi.length) {
      const reliable = scan.routes.filter(r => r.confidence !== "low").length;
      return [finding(X002, { message: `${scan.routes.length} HTTP route(s) found in code but the repository has no OpenAPI contract`, file: scan.routes[0].file, line: scan.routes[0].line, confidence: reliable ? "medium" : "low", evidence: scan.routes.slice(0, 6).map(r => `${r.method} ${r.path}`).join(", ") })];
    }
    const out: Finding[] = [];
    for (const r of scan.routes) {
      if (scan.openapi.some(d => d.ops.some(op => matchRoute(op, r, scan.config.basePath)))) continue;
      out.push(finding(X002, { message: `${r.method} ${r.path} exists in code but not in the spec`, file: r.file, line: r.line, nodeId: `route:${r.method} ${r.path}@${r.file}:${r.line}`, confidence: r.confidence, evidence: `${r.framework} route` }));
    }
    return out;
  }),

  rule(X003, ({ scan }) => {
    const out: Finding[] = [];
    for (const doc of scan.openapi) for (const op of doc.ops) for (const r of scan.routes) {
      if (matchRoute(op, r, scan.config.basePath) === "prefixed" && paramCount(op.path) !== paramCount(r.path))
        out.push(finding(X003, { message: `${op.key} matched ${r.method} ${r.path} but they differ in path parameters`, file: r.file, line: r.line, confidence: "low", evidence: `${op.path} vs ${r.path}` }));
    }
    return out;
  }),
];
