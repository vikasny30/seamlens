import type { CodeSmell, DetectedRoute, ImportEdge, OutboundCall, TableAccess } from "../model.js";

export const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
export const CODE_EXT = new Set([...JS_EXT, ".py", ".go", ".java", ".kt", ".rb", ".rs", ".php", ".cs"]);

export const isTestFile = (p: string) =>
  /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures|mocks?)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$|_test\.(py|go)$/.test(p);

/**
 * Blank out comments (keeping every newline so line numbers stay exact) while respecting string literals.
 * Without this, code in comments ("// app.get('/x')", "* DROP TABLE users") is mistaken for real code.
 */
export function maskComments(text: string, py: boolean): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) out.push(text[k] === "\n" ? "\n" : " "); };
  while (i < n) {
    const c = text[i];
    if (py) {
      if (c === "#") { let j = i; while (j < n && text[j] !== "\n") j++; blank(i, j); i = j; continue; }
      if ((c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
        const q = c.repeat(3); let j = text.indexOf(q, i + 3); j = j < 0 ? n : j + 3; out.push(text.slice(i, j)); i = j; continue;
      }
    } else if (c === "/" && text[i + 1] === "/") { let j = i; while (j < n && text[j] !== "\n") j++; blank(i, j); i = j; continue; }
    else if (c === "/" && text[i + 1] === "*") { let j = text.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === "\\") j++; else if (text[j] === "\n" && c !== "`") break; j++; }
      out.push(text.slice(i, Math.min(n, j + 1))); i = Math.min(n, j + 1); continue;
    }
    out.push(c); i++;
  }
  return out.join("");
}

const line = (text: string, idx: number) => text.slice(0, idx).split("\n").length;
const joinPath = (...parts: string[]) => ("/" + parts.filter(Boolean).join("/")).replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");

function balancedParen(s: string, open: number, limit = 1200): string {
  let depth = 0, q = "";
  for (let i = open; i < s.length && i < open + limit; i++) {
    const c = s[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = ""; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return s.slice(open, i + 1); }
  }
  return s.slice(open, open + limit);
}

/** Is `lineIdx` (0-based) inside a for/while/forEach/map block? Brace-depth walk for C-like code, indentation walk for Python. */
export function inLoop(lines: string[], lineIdx: number, py: boolean): string | null {
  const loopRe = py ? /^\s*(for|while)\b/ : /\b(for|while)\s*\(|\bfor\s+(?:await\s+)?\(|\.(forEach|map|flatMap|reduce|filter)\s*\(|\bfor\s+\w+\s+(of|in)\b/;
  if (py) {
    const indent = (s: string) => s.length - s.trimStart().length;
    let cur = indent(lines[lineIdx]);
    for (let i = lineIdx - 1; i >= 0 && lineIdx - i < 80; i--) {
      if (!lines[i].trim()) continue;
      const ind = indent(lines[i]);
      if (ind < cur) { if (loopRe.test(lines[i])) return lines[i]; cur = ind; if (ind === 0) break; }
    }
    return null;
  }
  let depth = 0;
  for (let i = lineIdx; i >= 0 && lineIdx - i < 80; i--) {
    const l = lines[i];
    const seg = i === lineIdx ? l.slice(0, l.length) : l;
    for (let k = seg.length - 1; k >= 0; k--) {
      if (seg[k] === "}") depth++;
      else if (seg[k] === "{") { depth--; if (depth < 0) { if (loopRe.test(lines[i])) return lines[i]; depth = 0; } }
    }
  }
  return null;
}

/** A loop that exists to retry is intended behavior, not an N+1. */
const RETRY_HEADER = /attempt|retry|retries|tries|backoff|poll/i;
const fanoutLoop = (lines: string[], idx: number, py: boolean) => { const h = inLoop(lines, idx, py); return !!h && !RETRY_HEADER.test(h); };

const NOT_ROUTERS = new Set(["axios", "got", "ky", "superagent", "request", "http", "https", "fetch", "supertest", "cy", "page", "window", "document", "map", "cache", "headers", "params", "searchParams", "localStorage", "sessionStorage", "Reflect", "Object", "res", "req", "response", "client"]);
const METHOD_RE = "get|post|put|patch|delete|head|options|all";

export function extractRoutes(file: string, text: string, py: boolean): DetectedRoute[] {
  const out: DetectedRoute[] = [];
  const add = (method: string, p: string, idx: number, framework: string, confidence: DetectedRoute["confidence"] = "medium") =>
    out.push({ method: method.toUpperCase(), path: joinPath(p), file, line: line(text, idx), framework, confidence });

  if (py) {
    const prefix = /APIRouter\([^)]*prefix\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? "";
    for (const m of text.matchAll(new RegExp(`@\\w+\\.(${METHOD_RE})\\(\\s*["']([^"']*)["']`, "g"))) add(m[1], joinPath(prefix, m[2]), m.index!, "fastapi", "high");
    for (const m of text.matchAll(/@\w+\.route\(\s*["']([^"']+)["'](?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?/g)) {
      const methods = (m[2] ?? "'GET'").match(/[A-Za-z]+/g) ?? ["GET"];
      for (const me of methods) add(me, m[1], m.index!, "flask", "high");
    }
    return out;
  }

  for (const m of text.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.(${METHOD_RE})\\s*\\(\\s*(['"\`])(\\/[^'"\`]*)\\3`, "g"))) {
    if (NOT_ROUTERS.has(m[1])) continue;
    add(m[2], m[4], m.index!, "express-like");
  }
  for (const m of text.matchAll(/\.route\(\s*(['"`])(\/[^'"`]*)\1\s*\)/g)) {
    const chain = text.slice(m.index! + m[0].length, m.index! + m[0].length + 500).split(";")[0];
    for (const c of chain.matchAll(new RegExp(`\\.(${METHOD_RE})\\s*\\(`, "g"))) add(c[1], m[2], m.index!, "express-like");
  }
  // NestJS
  const ctrl = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/.exec(text);
  if (ctrl) {
    for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) add(m[1], joinPath(ctrl[1] ?? "", m[2] ?? ""), m.index!, "nestjs", "high");
  }
  // raw Node http: pathname === '/x', startsWith('/x/'), match(/^\/x\/(\d+)$/)
  const lines = text.split("\n");
  const methodNear = (idx: number): string => {
    const ln = line(text, idx) - 1;
    for (let i = ln; i >= 0 && ln - i < 40; i--) { const mm = /\.method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/.exec(lines[i]); if (mm) return mm[1]; }
    return "ANY";
  };
  for (const m of text.matchAll(/\b(?:pathname|url\.pathname|path)\s*===?\s*(['"`])(\/[^'"`]*)\1/g)) add(methodNear(m.index!), m[2], m.index!, "node-http", "low");
  for (const m of text.matchAll(/pathname\.startsWith\(\s*(['"`])(\/[^'"`]*)\1/g)) add(methodNear(m.index!), joinPath(m[2], "{}"), m.index!, "node-http", "low");
  for (const m of text.matchAll(/pathname\.match\(\s*\/\^?((?:\\\/|[^/\n])+?)\$?\/\s*\)/g)) {
    const p = m[1].replace(/\\\//g, "/").replace(/\([^)]*\)/g, "{}");
    if (p.startsWith("/")) add(methodNear(m.index!), p, m.index!, "node-http", "low");
  }
  return out;
}

export function resolveImport(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const parts = (dir ? dir.split("/") : []).concat(spec.split("/"));
  const stack: string[] = [];
  for (const p of parts) { if (p === "." || p === "") continue; if (p === "..") stack.pop(); else stack.push(p); }
  const base = stack.join("/");
  const stripped = base.replace(/\.(m|c)?jsx?$/, "");
  const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${stripped}.ts`, `${stripped}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`];
  return cands.find(c => files.has(c)) ?? null;
}

export function extractImports(file: string, text: string, py: boolean, files: Set<string>): ImportEdge[] {
  const out = new Set<string>();
  const add = (to: string | null) => { if (to && to !== file) out.add(to); };
  if (py) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const tryMod = (mod: string, relBase: string) => {
      const p = (relBase ? relBase + "/" : "") + mod.replace(/\./g, "/");
      return [`${p}.py`, `${p}/__init__.py`].find(c => files.has(c)) ?? null;
    };
    for (const m of text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+([\w, *]+)/gm)) {
      let base = dir; for (let i = 1; i < m[1].length; i++) base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
      add(m[2] ? tryMod(m[2], base) : null);
      if (!m[2]) for (const n of m[3].split(",")) add(tryMod(n.trim(), base));
    }
    const top = file.split("/")[0];
    for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) { const mod = m[1] ?? m[2]; add(tryMod(mod, "") ?? tryMod(mod, top)); }
    return [...out].map(to => ({ from: file, to }));
  }
  // Type-only imports are erased at compile time and create no runtime dependency, so they are not edges.
  const isTypeOnly = (clause: string) => {
    const c = clause.trim();
    if (/^type\s/.test(c)) return true;
    const named = /^\{([\s\S]*)\}$/.exec(c);
    return !!named && named[1].split(",").map(x => x.trim()).filter(Boolean).every(x => /^type\s/.test(x));
  };
  for (const m of text.matchAll(/\b(?:import|export)\s+([^'"`;]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g)) if (!isTypeOnly(m[1])) add(resolveImport(file, m[2], files));
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) add(resolveImport(file, m[1], files));
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(resolveImport(file, m[1], files));
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(resolveImport(file, m[1], files));
  return [...out].map(to => ({ from: file, to }));
}

const HTTP_JS = /(?<![|\w$])(fetch|axios(?:\.(?:get|post|put|patch|delete|head|request))?|got(?:\.(?:get|post|put|patch|delete))?|ky(?:\.(?:get|post|put|patch|delete))?)\s*\((?!\?)/g;
const HTTP_PY = /\b(requests|httpx)\.(get|post|put|patch|delete|head|request)\s*\(/g;

export function extractOutbound(file: string, text: string, py: boolean): OutboundCall[] {
  const out: OutboundCall[] = [];
  const lines = text.split("\n");
  const re = py ? HTTP_PY : HTTP_JS;
  const axiosTimeoutDefault = /axios\.create\([^)]*timeout|axios\.defaults\.timeout/.test(text);
  for (const m of text.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const call = balancedParen(text, open);
    // skip method definitions and property accesses like `this.fetch(` / `client.fetch(`
    const before = text.slice(Math.max(0, m.index! - 2), m.index!);
    if (!py && /[.\w$]$/.test(before) && !/^\s*$/.test(before)) continue;
    const kind = py ? m[1] : m[1].split(".")[0];
    const urlMatch = /(['"`])(https?:\/\/[^'"`\s$]+)/.exec(call);
    let host: string | undefined;
    if (urlMatch) { try { host = new URL(urlMatch[2]).host; } catch { host = urlMatch[2].replace(/^https?:\/\//, "").split("/")[0]; } }
    const hasTimeout = py ? /\btimeout\s*=/.test(call) : /\b(signal|timeout|AbortSignal|AbortController)\b/.test(call) || (kind === "axios" && axiosTimeoutDefault);
    const ln = line(text, m.index!);
    out.push({ kind, url: urlMatch?.[2], host, hasTimeout, file, line: ln, inLoop: fanoutLoop(lines, ln - 1, py), text: lines[ln - 1].trim().slice(0, 160) });
  }
  return out;
}

const DB_CALL_JS = /\bawait\s+[\w$.]*(?:db|pool|prisma|knex|client|conn|connection|repo|repository|model|collection|session|sql)[\w$.]*\.(?:query|execute|exec|find\w*|get\w*|select|insert\w*|update\w*|delete\w*|save|run|all|one|count)\s*\(/;
const DB_CALL_PY = /\b(?:cursor|session|conn|db|connection)\.(?:execute|query|get|filter|add|commit|fetch\w*)\s*\(/;

export function extractSmells(file: string, text: string, py: boolean, raw: string = text): CodeSmell[] {
  const out: CodeSmell[] = [];
  const lines = text.split("\n");
  const emptyRe = py ? /except[^:\n]*:\s*\n?\s*pass\b/g : /catch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(?:\([^)]*\)|\w*)\s*=>\s*\{\s*\}\s*\)/g;
  for (const m of text.matchAll(emptyRe)) {
    // `text` has comments blanked; the same span in the raw source must also be truly empty, so `catch { /* why */ }` counts as documented
    if (!new RegExp(`^(?:${emptyRe.source})$`).test(raw.slice(m.index!, m.index! + m[0].length))) continue;
    out.push({ kind: "empty_catch", file, line: line(text, m.index!), text: m[0].replace(/\s+/g, " ").slice(0, 120) });
  }
  const dbRe = py ? DB_CALL_PY : DB_CALL_JS;
  lines.forEach((l, i) => { if (dbRe.test(l) && fanoutLoop(lines, i, py)) out.push({ kind: "db_in_loop", file, line: i + 1, text: l.trim().slice(0, 140) }); });
  const retry = /\b(max_?retries|retries|retry_?count|retry_?attempts|max_?attempts|attempts?)\s*(?:=|<=|<|>=|>|\+\+|--|\+=|-=)/i.exec(text);   // a counter being used, not the word in prose
  if (retry && /\b(for|while)\b/.test(text) && !/\b(backoff|jitter|Math\.pow|\*\*\s*\w*attempt|setTimeout|sleep|delay|wait\()/i.test(text))
    out.push({ kind: "retry_no_backoff", file, line: line(text, retry.index), text: lines[line(text, retry.index) - 1].trim().slice(0, 140) });
  return out;
}

export function extractTableAccess(file: string, text: string, tables: string[]): TableAccess[] {
  const out: TableAccess[] = [];
  for (const t of tables) {
    const re = new RegExp(`\\b(insert\\s+(?:or\\s+\\w+\\s+)?into|update|delete\\s+from|from|join)\\s+["\`\\[]?${t}\\b`, "gi");
    for (const m of text.matchAll(re)) {
      const ln = line(text, m.index!);
      const lt = text.split("\n")[ln - 1] ?? "";
      if (/create\s+(unique\s+)?(table|index)/i.test(lt)) continue;
      out.push({ file, table: t, mode: /^(insert|update|delete)/i.test(m[1]) ? "write" : "read", line: ln });
    }
  }
  return out;
}
