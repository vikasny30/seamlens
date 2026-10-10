import type { OaDoc, OaOperation } from "../model.js";
import { deref } from "../scan/extract-openapi.js";
import type { Change, ChangeLevel } from "./types.js";

type Dir = "request" | "response";
interface Ctx { base: any; head: any; subject: string; file: string; dir: Dir; out: Change[]; seen: Set<string> }

const add = (c: Ctx, level: ChangeLevel, kind: string, message: string) => c.out.push({ level, kind, subject: c.subject, message, file: c.file });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffSchema(c: Ctx, b: any, h: any, path: string, depth = 0) {
  const bs = deref(c.base, b), hs = deref(c.head, h);
  if (!bs || !hs || typeof bs !== "object" || typeof hs !== "object" || depth > 10) return;
  const key = `${path}|${depth}`;
  if (c.seen.has(key + JSON.stringify(Object.keys(bs.properties ?? {})))) return;
  c.seen.add(key + JSON.stringify(Object.keys(bs.properties ?? {})));
  const where = path || "(body)";
  const req = c.dir === "request";

  if (bs.type !== hs.type && (bs.type || hs.type)) add(c, "breaking", `${c.dir}-type-changed`, `${where}: type changed from ${bs.type ?? "(none)"} to ${hs.type ?? "(none)"}`);
  else if (bs.format !== hs.format && bs.format !== undefined) add(c, req ? "breaking" : "potentially-breaking", `${c.dir}-format-changed`, `${where}: format changed from ${bs.format} to ${hs.format ?? "(none)"}`);

  if (Array.isArray(bs.enum) || Array.isArray(hs.enum)) {
    const be: any[] = bs.enum ?? [], he: any[] = hs.enum ?? [];
    const removed = be.filter(v => !he.includes(v)), added = he.filter(v => !be.includes(v));
    if (be.length && !he.length) { /* enum dropped entirely: widening, safe */ }
    else {
      if (removed.length) add(c, req ? "breaking" : "safe", `${c.dir}-enum-removed`, `${where}: enum value(s) removed: ${removed.join(", ")}`);
      if (added.length && be.length) add(c, req ? "safe" : "potentially-breaking", `${c.dir}-enum-added`, `${where}: enum value(s) added: ${added.join(", ")}${req ? "" : " (clients with an exhaustive switch will fail)"}`);
      if (!be.length && he.length) add(c, req ? "breaking" : "safe", `${c.dir}-enum-introduced`, `${where}: value set restricted to ${he.join(", ")}`);
    }
  }

  if (req) {
    const narrower: [string, (x: number, y: number) => boolean][] = [["maxLength", (x, y) => y < x], ["maxItems", (x, y) => y < x], ["maximum", (x, y) => y < x], ["maxProperties", (x, y) => y < x],
      ["minLength", (x, y) => y > x], ["minItems", (x, y) => y > x], ["minimum", (x, y) => y > x], ["minProperties", (x, y) => y > x]];
    for (const [k, worse] of narrower) {
      if (typeof hs[k] === "number" && (typeof bs[k] !== "number" || worse(bs[k], hs[k]))) add(c, "breaking", "request-constraint-narrowed", `${where}: ${k} ${typeof bs[k] === "number" ? `tightened from ${bs[k]} to` : "added:"} ${hs[k]}`);
    }
    if (hs.pattern && hs.pattern !== bs.pattern) add(c, "breaking", "request-constraint-narrowed", `${where}: pattern ${bs.pattern ? "changed" : "added"}`);
    if (bs.nullable === true && hs.nullable !== true) add(c, "breaking", "request-nullable-removed", `${where}: no longer accepts null`);
  } else if (hs.nullable === true && bs.nullable !== true) add(c, "potentially-breaking", "response-nullable-added", `${where}: may now be null`);

  const bp = bs.properties ?? {}, hp = hs.properties ?? {};
  const bReq = new Set<string>(bs.required ?? []), hReq = new Set<string>(hs.required ?? []);
  for (const k of Object.keys(bp)) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in hp)) { add(c, req ? "potentially-breaking" : "breaking", `${c.dir}-property-removed`, `${p}: property removed`); continue; }
    diffSchema(c, bp[k], hp[k], p, depth + 1);
    if (!req && bReq.has(k) && !hReq.has(k)) add(c, "breaking", "response-property-optional", `${p}: no longer guaranteed to be present`);
  }
  for (const k of Object.keys(hp)) {
    if (k in bp) continue;
    const p = path ? `${path}.${k}` : k;
    if (req && hReq.has(k)) add(c, "breaking", "request-property-required", `${p}: new required property`);
    else add(c, "safe", `${c.dir}-property-added`, `${p}: ${req ? "optional " : ""}property added`);
  }
  if (req) for (const k of hReq) if (k in bp && !bReq.has(k)) add(c, "breaking", "request-property-required", `${path ? path + "." : ""}${k}: became required`);

  if (bs.items && hs.items) diffSchema(c, bs.items, hs.items, `${path}[]`, depth + 1);
  for (const k of ["oneOf", "anyOf", "allOf"] as const) {
    const bl: any[] = bs[k] ?? [], hl: any[] = hs[k] ?? [];
    if (bl.length !== hl.length) add(c, "potentially-breaking", `${c.dir}-${k}-changed`, `${where}: ${k} went from ${bl.length} to ${hl.length} options`);
    for (let i = 0; i < Math.min(bl.length, hl.length); i++) diffSchema(c, bl[i], hl[i], `${path}<${k}${i}>`, depth + 1);
  }
}

const effSecurity = (doc: OaDoc, op: OaOperation) => (op.security !== undefined ? op.security : doc.globalSecurity) ?? [];

export function diffOpenApi(base: OaDoc, head: OaDoc): Change[] {
  const out: Change[] = [];
  const file = head.file;
  const bOps = new Map(base.ops.map(o => [o.key, o])), hOps = new Map(head.ops.map(o => [o.key, o]));
  for (const [k, bo] of bOps) {
    const ho = hOps.get(k);
    if (!ho) { out.push({ level: "breaking", kind: "operation-removed", subject: k, message: "operation removed", file }); continue; }
    const ctx = (dir: Dir): Ctx => ({ base: base.raw, head: head.raw, subject: k, file, dir, out, seen: new Set() });

    // parameters
    const bp = new Map(bo.parameters.map(p => [`${p.in}:${p.name}`, p])), hp = new Map(ho.parameters.map(p => [`${p.in}:${p.name}`, p]));
    for (const [pk, p] of bp) {
      const q = hp.get(pk);
      if (!q) { out.push({ level: "potentially-breaking", kind: "parameter-removed", subject: k, message: `${p.in} parameter "${p.name}" removed`, file }); continue; }
      if (!p.required && q.required) out.push({ level: "breaking", kind: "parameter-required", subject: k, message: `${q.in} parameter "${q.name}" became required`, file });
      const c = ctx("request");
      const before = out.length;
      diffSchema({ ...c, subject: k }, p.schema, q.schema, `${p.in}:${p.name}`);
      for (let i = before; i < out.length; i++) out[i].kind = out[i].kind.replace("request-", "parameter-");
    }
    for (const [pk, q] of hp) if (!bp.has(pk)) out.push(q.required ? { level: "breaking", kind: "parameter-added-required", subject: k, message: `new required ${q.in} parameter "${q.name}"`, file } : { level: "safe", kind: "parameter-added", subject: k, message: `new optional ${q.in} parameter "${q.name}"`, file });

    // request body
    if (!bo.requestBody && ho.requestBody?.required) out.push({ level: "breaking", kind: "request-body-required", subject: k, message: "a required request body was added", file });
    else if (bo.requestBody && ho.requestBody) {
      if (!bo.requestBody.required && ho.requestBody.required) out.push({ level: "breaking", kind: "request-body-required", subject: k, message: "request body became required", file });
      diffSchema(ctx("request"), bo.requestBody.schema, ho.requestBody.schema, "");
    } else if (bo.requestBody && !ho.requestBody) out.push({ level: "potentially-breaking", kind: "request-body-removed", subject: k, message: "request body removed", file });

    // responses
    const br = new Map(bo.responses.map(r => [r.status, r])), hr = new Map(ho.responses.map(r => [r.status, r]));
    for (const [st, r] of br) {
      const q = hr.get(st);
      if (!q) { out.push({ level: /^2/.test(st) ? "breaking" : "safe", kind: "response-removed", subject: k, message: `${st} response removed`, file }); continue; }
      if (r.schema && q.schema) { const c = ctx("response"); c.subject = k; const n = out.length; diffSchema(c, r.schema, q.schema, ""); for (let i = n; i < out.length; i++) out[i].message = `[${st}] ${out[i].message}`; }
    }
    for (const st of hr.keys()) if (!br.has(st)) out.push({ level: "safe", kind: "response-added", subject: k, message: `${st} response added`, file });

    // security
    const bsec = effSecurity(base, bo), hsec = effSecurity(head, ho);
    if (!bsec.length && hsec.length) out.push({ level: "breaking", kind: "security-added", subject: k, message: "operation now requires authentication", file });
    else if (bsec.length && !hsec.length) out.push({ level: "safe", kind: "security-removed", subject: k, message: "operation no longer requires authentication (check this is intended)", file });
    else if (bsec.length && hsec.length && !same(bsec, hsec)) out.push({ level: "potentially-breaking", kind: "security-changed", subject: k, message: "security requirement changed", file });
    if (!bo.deprecated && ho.deprecated) out.push({ level: "safe", kind: "deprecated", subject: k, message: "operation deprecated", file });
  }
  for (const [k] of hOps) if (!bOps.has(k)) out.push({ level: "safe", kind: "operation-added", subject: k, message: "operation added", file });
  return out;
}
