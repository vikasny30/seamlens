import type { OaDoc, OaOperation, RuleMeta } from "../model.js";
import { deref, walkSchema } from "../scan/extract-openapi.js";
import { finding, rule } from "./util.js";

const nid = (doc: OaDoc, op: OaOperation) => `op:${doc.file}:${op.key}`;

const A001: RuleMeta = { id: "API001", title: "Operation has a unique operationId", category: "http", severity: "warning",
  why: "Client generators, logs and traces key on operationId. Missing IDs produce unstable generated names; duplicates break code generation outright.",
  fix: "Give every operation a unique, stable operationId (verbNoun, for example listOrders)." };
const A002: RuleMeta = { id: "API002", title: "Errors are part of the contract and consistent", category: "http", severity: "warning",
  why: "Consumers need to know what failure looks like. Operations that define no error response, or APIs with several different error shapes, force every client to guess and special-case.",
  fix: "Define one shared Error schema (code, message, request id) and reference it from every 4xx/5xx or a `default` response." };
const A003: RuleMeta = { id: "API003", title: "Collection endpoints are paginated", category: "http", severity: "warning",
  why: "An unbounded list works in staging and takes production down when the table grows. Adding pagination later is a breaking change for clients that assumed everything comes back.",
  fix: "Add limit/cursor (preferred) or page/page_size parameters and return a next cursor; set a server-side maximum." };
const A004: RuleMeta = { id: "API004", title: "Payment-like POST accepts an idempotency key", category: "http", severity: "warning",
  why: "Networks retry. Without an idempotency key a retried order, payment or transfer is processed twice.",
  fix: "Accept an `Idempotency-Key` header, store the first result for that key, and return it on replays." };
const A005: RuleMeta = { id: "API005", title: "Authentication is declared", category: "http", severity: "warning",
  why: "An API with no declared security scheme cannot be reviewed for who may call what, and generated clients and gateways cannot enforce it.",
  fix: "Declare `components.securitySchemes` and apply `security` globally, opting out explicitly with `security: []` only for public operations." };
const A006: RuleMeta = { id: "API006", title: "A versioning strategy exists", category: "http", severity: "warning",
  why: "Without a version in the path, host or media type there is no safe way to ship a breaking change: every change is breaking for someone.",
  fix: "Version the API (`/v1/...` or a version in `servers`) and document the deprecation policy." };
const A007: RuleMeta = { id: "API007", title: "Naming is consistent", category: "http", severity: "warning",
  why: "Mixed camelCase and snake_case property names, or verbs in resource paths, are the most common source of client bugs and review churn.",
  fix: "Pick one casing for properties and nouns (plural) for resources; use HTTP methods for the verb." };
const A008: RuleMeta = { id: "API008", title: "Request input is bounded", category: "http", severity: "info",
  why: "Strings without maxLength and arrays without maxItems let a single request consume arbitrary memory and database space.",
  fix: "Add maxLength/maxItems (and enforce them at the edge) on every request field that comes from users." };
const A009: RuleMeta = { id: "API009", title: "Rate limiting is part of the contract", category: "http", severity: "info",
  why: "If 429 and Retry-After are not in the contract, clients retry blindly and amplify an overload.",
  fix: "Document a 429 response with a Retry-After header on throttled operations." };
const A010: RuleMeta = { id: "API010", title: "Write operations document validation errors", category: "http", severity: "warning",
  why: "A write with a body can always be rejected for invalid input. If 400/422 is not documented, clients cannot show field errors.",
  fix: "Add a 400 or 422 response using the shared Error schema, with per-field details." };
const A011: RuleMeta = { id: "API011", title: "Creating returns 201 or 202", category: "http", severity: "info",
  why: "201 tells clients a resource now exists (with a Location); 202 tells them work was accepted. A bare 200 hides which one happened.",
  fix: "Return 201 with a Location header for synchronous creation, 202 for asynchronous." };
const A012: RuleMeta = { id: "API012", title: "GET and DELETE have no request body", category: "http", severity: "warning",
  why: "Proxies, caches and many clients drop or reject bodies on GET and DELETE, so the contract silently fails in production.",
  fix: "Use query parameters for GET and DELETE, or switch to POST for complex queries." };

const ERR_RE = /^(4|5)\d\d$|^[45]XX$|^default$/i;
const PAGE_RE = /^(limit|cursor|page|offset|page_?size|per_?page|after|before|next_?token|page_?token|starting_?after|top|skip)$/i;

function schemaSig(doc: OaDoc, s: any): string {
  if (!s) return "none";
  if (typeof s.$ref === "string") return s.$ref;
  const d = deref(doc.raw, s);
  return "inline:" + Object.keys(d?.properties ?? {}).sort().join(",");
}
const isArrayish = (doc: OaDoc, s: any): boolean => {
  const d = deref(doc.raw, s);
  if (!d) return false;
  if (d.type === "array") return true;
  return Object.values<any>(d.properties ?? {}).some(p => deref(doc.raw, p)?.type === "array") && /(data|items|results|list|records)/i.test(Object.keys(d.properties ?? {}).join(","));
};

export const httpRules = [
  rule(A001, ({ scan }) => scan.openapi.flatMap(doc => {
    const out = [];
    const seen = new Map<string, OaOperation>();
    for (const op of doc.ops) {
      if (!op.operationId) out.push(finding(A001, { message: `${op.key} has no operationId`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: op.key }));
      else if (seen.has(op.operationId)) out.push(finding(A001, { severity: "error", message: `operationId "${op.operationId}" is used by both ${seen.get(op.operationId)!.key} and ${op.key}`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: op.operationId }));
      else seen.set(op.operationId, op);
    }
    return out;
  })),

  rule(A002, ({ scan }) => scan.openapi.flatMap(doc => {
    const out = [];
    const sigs = new Map<string, number>();
    for (const op of doc.ops) {
      const errs = op.responses.filter(r => ERR_RE.test(r.status));
      if (!errs.length) out.push(finding(A002, { message: `${op.key} defines no error response (4xx, 5xx or default)`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: `responses: ${op.responses.map(r => r.status).join(", ") || "none"}` }));
      for (const e of errs) { const sg = schemaSig(doc, e.schema); if (sg !== "none") sigs.set(sg, (sigs.get(sg) ?? 0) + 1); }
    }
    if (sigs.size > 1) out.push(finding(A002, { message: `${sigs.size} different error shapes are used across this API`, file: doc.file, line: 1, evidence: [...sigs].map(([k, v]) => `${k} (${v}x)`).join("; ") }));
    return out;
  })),

  rule(A003, ({ scan }) => scan.openapi.flatMap(doc => doc.ops.flatMap(op => {
    if (op.method !== "GET" || /\}\/?$/.test(op.path)) return [];
    const ok = op.responses.find(r => /^2/.test(r.status));
    if (!ok || !isArrayish(doc, ok.schema)) return [];
    if (op.parameters.some(p => p.in === "query" && PAGE_RE.test(p.name))) return [];
    return [finding(A003, { message: `${op.key} returns a list with no pagination parameter`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: `query params: ${op.parameters.filter(p => p.in === "query").map(p => p.name).join(", ") || "none"}` })];
  }))),

  rule(A004, ({ scan }) => scan.openapi.flatMap(doc => doc.ops.flatMap(op => {
    if (op.method !== "POST" || !/(order|payment|charge|transfer|invoice|checkout|booking|purchase|subscription|refund)/i.test(op.path)) return [];
    if (op.parameters.some(p => p.in === "header" && /idempotenc/i.test(p.name))) return [];
    return [finding(A004, { message: `${op.key} looks like a payment or order action but takes no Idempotency-Key`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: `header params: ${op.parameters.filter(p => p.in === "header").map(p => p.name).join(", ") || "none"}` })];
  }))),

  rule(A005, ({ scan }) => scan.openapi.flatMap(doc => {
    const out = [];
    const anySecurity = doc.globalSecurity?.length || doc.ops.some(o => o.security?.length);
    if (!doc.securitySchemes.length && !anySecurity) out.push(finding(A005, { message: "No authentication is declared anywhere in this API", file: doc.file, line: 1, evidence: "no securitySchemes, no security requirement" }));
    const pub = doc.ops.filter(o => Array.isArray(o.security) && o.security.length === 0);
    if (pub.length && anySecurity) out.push(finding(A005, { severity: "info", message: `${pub.length} operation(s) are explicitly public: ${pub.slice(0, 5).map(o => o.key).join(", ")}`, file: doc.file, line: 1 }));
    return out;
  })),

  rule(A006, ({ scan }) => scan.openapi.flatMap(doc => {
    const hasPathVersion = doc.ops.some(o => /^\/v\d+(\/|$)/.test(o.path)) || doc.servers.some(s => /\/v\d+(\/|$)/.test(s));
    if (hasPathVersion) return [];
    return [finding(A006, { message: "No version in any path or server URL, so a breaking change has nowhere to go", file: doc.file, line: 1, evidence: `info.version=${doc.version || "(none)"}; servers=${doc.servers.join(", ") || "(none)"}` })];
  })),

  rule(A007, ({ scan }) => scan.openapi.flatMap(doc => {
    const out = [];
    const camel = new Set<string>(), snake = new Set<string>();
    const visit = (s: any) => walkSchema(doc.raw, s, (sch) => { for (const k of Object.keys(sch.properties ?? {})) { if (k.includes("_")) snake.add(k); else if (/[a-z][A-Z]/.test(k)) camel.add(k); } });
    for (const op of doc.ops) { visit(op.requestBody?.schema); for (const r of op.responses) visit(r.schema); }
    for (const s of Object.values<any>(doc.raw.components?.schemas ?? doc.raw.definitions ?? {})) visit(s);
    if (camel.size >= 2 && snake.size >= 2) out.push(finding(A007, { message: `Property names mix camelCase and snake_case`, file: doc.file, line: 1, evidence: `camelCase: ${[...camel].slice(0, 3).join(", ")}; snake_case: ${[...snake].slice(0, 3).join(", ")}` }));
    for (const op of doc.ops) if (op.method === "GET" || true) {
      const seg = op.path.split("/").find(s => /^(get|create|delete|update|list|fetch|remove|add)([A-Z_-]|$)/.test(s));
      if (seg) out.push(finding(A007, { severity: "info", message: `${op.key} puts a verb ("${seg}") in the path`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: op.path }));
    }
    return out;
  })),

  rule(A008, ({ scan }) => scan.openapi.flatMap(doc => {
    let unboundedStrings = 0, unboundedArrays = 0;
    const examples: string[] = [];
    for (const op of doc.ops) walkSchema(doc.raw, op.requestBody?.schema, (s, p) => {
      if (s.type === "string" && s.maxLength === undefined && !s.enum && !/^(uuid|date|date-time|binary|byte)$/.test(s.format ?? "")) { unboundedStrings++; if (examples.length < 3) examples.push(`${op.key} ${p || "(body)"}`); }
      if (s.type === "array" && s.maxItems === undefined) { unboundedArrays++; if (examples.length < 3) examples.push(`${op.key} ${p || "(body)"} (array)`); }
    });
    if (!unboundedStrings && !unboundedArrays) return [];
    return [finding(A008, { message: `${unboundedStrings} request string(s) have no maxLength and ${unboundedArrays} array(s) have no maxItems`, file: doc.file, line: 1, evidence: examples.join("; ") })];
  })),

  rule(A009, ({ scan }) => scan.openapi.flatMap(doc => {
    const has429 = doc.ops.some(o => o.responses.some(r => r.status === "429" || r.headers?.some(h => /ratelimit|retry-after/i.test(h))));
    return has429 || !doc.ops.length ? [] : [finding(A009, { message: "No 429 response or Retry-After header is documented anywhere", file: doc.file, line: 1 })];
  })),

  rule(A010, ({ scan }) => scan.openapi.flatMap(doc => doc.ops.flatMap(op => {
    if (!["POST", "PUT", "PATCH"].includes(op.method) || !op.requestBody) return [];
    if (op.responses.some(r => /^(400|422|4XX|default)$/i.test(r.status))) return [];
    return [finding(A010, { message: `${op.key} takes a body but documents no 400/422 validation response`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: `responses: ${op.responses.map(r => r.status).join(", ")}` })];
  }))),

  rule(A011, ({ scan }) => scan.openapi.flatMap(doc => doc.ops.flatMap(op => {
    if (op.method !== "POST" || /\}\/?$/.test(op.path) || /(search|login|logout|verify|query|batch|token|callback|webhook)/i.test(op.path)) return [];
    const codes = op.responses.map(r => r.status);
    if (codes.includes("200") && !codes.some(c => ["201", "202", "204"].includes(c))) return [finding(A011, { message: `${op.key} creates something but answers 200`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: `success codes: ${codes.filter(c => /^2/.test(c)).join(", ")}` })];
    return [];
  }))),

  rule(A012, ({ scan }) => scan.openapi.flatMap(doc => doc.ops.flatMap(op =>
    ["GET", "DELETE"].includes(op.method) && op.requestBody
      ? [finding(A012, { message: `${op.key} declares a request body`, file: op.file, line: op.line, nodeId: nid(doc, op), evidence: op.key })] : []))),
];

export const httpMeta = [A001, A002, A003, A004, A005, A006, A007, A008, A009, A010, A011, A012];
